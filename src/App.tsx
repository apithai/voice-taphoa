import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Mic,
  MicOff,
  Settings as SettingsIcon,
  Package,
  History as HistoryIcon,
  Download,
  Copy,
  Check,
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Trash2,
  Send,
  RefreshCw,
  FileSpreadsheet,
  Bot,
  Search,
  Sparkles,
  CheckCircle2,
  Clock,
  RotateCcw,
  Plus,
  QrCode,
  Smartphone,
  Cloud,
} from 'lucide-react';

import { Transaction, TransactionType, InventoryItem, AppSettings, ParsedVoiceResult } from './types';
import { parseVietnameseMulti, mergePendingItems } from './utils/nlpParser';
import { playSoundTone, speakVietnamese } from './utils/audioFeedback';
import { buildVietQrUrl, buildTransferNote } from './utils/vietqr';
import type { CatalogItem } from './utils/catalogMatch';
import { resolveWithCatalog, chooseCatalogItem, parseCatalogCsv } from './utils/resolveCatalog';
import {
  DEFAULT_SETTINGS,
  INITIAL_INVENTORY,
  formatVND,
  formatDateTime,
  syncBatchToGoogleSheets,
  syncToGoogleSheets,
  testGoogleSheetsConnection,
  buildTelegramBatchText,
  sendTelegramMessage,
  buildTelegramTransactionText,
  applyAutoPrice,
  normalizeVietnameseText,
  fetchServerSync,
  pushServerSync,
} from './utils/apiSync';
import { GOOGLE_APPS_SCRIPT_CODE } from './utils/gasCode';
import { generateStandaloneHtml } from './utils/standaloneHtmlGenerator';

// Types cho Web Speech API
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: {
        transcript: string;
      };
    };
  };
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
}

interface ToastState {
  message: string;
  type: 'success' | 'error' | 'info';
  undoTxId?: string;
}

/**
 * Ô sửa giá trực tiếp trong bảng Tồn kho (chỉ nhận số >= 0, lưu khi rời ô hoặc Enter)
 */
const PriceEditableCell: React.FC<{
  value?: number;
  onSave: (val: number) => void;
}> = ({ value, onSave }) => {
  const [val, setVal] = useState<string>(value && value > 0 ? String(value) : '');

  useEffect(() => {
    setVal(value && value > 0 ? String(value) : '');
  }, [value]);

  const commitVal = () => {
    const num = parseFloat(val);
    const cleaned = isNaN(num) || num <= 0 ? 0 : Math.round(num);
    if (cleaned !== (value || 0)) {
      onSave(cleaned);
    }
    setVal(cleaned > 0 ? String(cleaned) : '');
  };

  return (
    <div className="relative w-28 sm:w-32 ml-auto">
      <input
        type="number"
        min="0"
        value={val}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '' || parseFloat(v) >= 0) {
            setVal(v);
          }
        }}
        onBlur={commitVal}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          }
        }}
        placeholder="Chưa có giá"
        className="w-full text-right bg-slate-950/80 border border-slate-800 focus:border-emerald-500 rounded-lg px-2.5 py-1 text-xs text-white placeholder:text-slate-500 placeholder:italic focus:outline-none transition"
      />
    </div>
  );
};

/* Câu đọc xác nhận: liệt kê từng mặt hàng, câu chốt đọc thành tiền */
type SpokenItem = { type: 'NHAP' | 'BAN' | null; quantity: number | null; unit: string; productName: string; totalPrice?: number | null };
const buildSpokenReadBack = (items: SpokenItem[], detailed: boolean): string => {
  const verb = (t: SpokenItem['type']) => (t === 'NHAP' ? 'nhập' : 'bán');
  const lineFor = (i: SpokenItem) =>
    `${verb(i.type)} ${i.quantity} ${i.unit} ${i.productName}` +
    (i.totalPrice ? `, thành tiền ${i.totalPrice} đồng` : '');
  const total = items.reduce((acc, i) => acc + (i.totalPrice || 0), 0);
  const hasTotal = total > 0;

  if (detailed) {
    const lines = items.map(lineFor);
    if (items.length > 1 && hasTotal) lines.push(`Tổng thành tiền ${total} đồng`);
    return lines.join('. ');
  }
  if (items.length === 1) return `Đã ghi nhận ${lineFor(items[0])}`;
  return `Đã ghi ${items.length} mặt hàng` + (hasTotal ? `, tổng thành tiền ${total} đồng` : '');
};

export default function App() {
  // --- States ---
  const [activeTab, setActiveTab] = useState<'record' | 'stock' | 'history' | 'guide'>('record');
  const [inventory, setInventory] = useState<InventoryItem[]>(() => {
    try {
      const saved = localStorage.getItem('voicestock_inventory');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed.map((item: InventoryItem) => ({
            ...item,
            sellPrice: typeof item.sellPrice === 'number' ? item.sellPrice : 0,
            importPrice: typeof item.importPrice === 'number' ? item.importPrice : 0,
          }));
        }
      }
      return INITIAL_INVENTORY;
    } catch {
      return INITIAL_INVENTORY;
    }
  });

  const [history, setHistory] = useState<Transaction[]>(() => {
    try {
      const saved = localStorage.getItem('voicestock_history');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const saved = localStorage.getItem('voicestock_settings');
      return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  // Voice Recognition states
  const [isListening, setIsListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [parsedResult, setParsedResult] = useState<ParsedVoiceResult | null>(null);
  // Nhiều mặt hàng trong cùng một lệnh nói (chờ xác nhận / ghi)
  const [parsedBatch, setParsedBatch] = useState<ParsedVoiceResult[]>([]);
  const [autoSaveRemaining, setAutoSaveRemaining] = useState<number | null>(null);

  // Settings Modal & Notification states
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [testSheetsStatus, setTestSheetsStatus] = useState<{ loading: boolean; msg: string; success?: boolean } | null>(null);
  const [testTgStatus, setTestTgStatus] = useState<{ loading: boolean; msg: string; success?: boolean } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedDownload, setCopiedDownload] = useState(false);
  const [statusToast, setStatusToast] = useState<ToastState | null>(null);

  // QR Payment modal state (VietQR)
  const [qrTx, setQrTx] = useState<Transaction | null>(null);
  const [qrImgError, setQrImgError] = useState(false);

  // Danh mục sản phẩm (tải từ Google Sheet hoặc nhập từ file CSV)
  const [catalog, setCatalog] = useState<CatalogItem[]>(() => {
    try {
      const saved = localStorage.getItem('voicestock_catalog');
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [catalogUpdated, setCatalogUpdated] = useState<string>(() => {
    try {
      return localStorage.getItem('voicestock_catalog_updated') || '';
    } catch {
      return '';
    }
  });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  const csvInputRef = useRef<HTMLInputElement | null>(null);

  // Multi-device Cloud Sync (Máy tính & Điện thoại)
  const [syncStatus, setSyncStatus] = useState<'synced' | 'syncing' | 'offline'>('synced');
  const [lastSyncTime, setLastSyncTime] = useState<string>('');
  const [showMobileConnectModal, setShowMobileConnectModal] = useState(false);
  const [copiedMobileLink, setCopiedMobileLink] = useState(false);
  const lastServerTimestampRef = useRef<number>(0);
  const isSyncingRef = useRef(false);

  useEffect(() => {
    if (qrTx) {
      setQrImgError(false);
    }
  }, [qrTx]);

  // Search & Filter
  const [stockSearch, setStockSearch] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [historyTypeFilter, setHistoryTypeFilter] = useState<'ALL' | 'NHAP' | 'BAN'>('ALL');

  // Add Product Form states (Yêu cầu 6)
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [newProdName, setNewProdName] = useState('');
  const [newProdUnit, setNewProdUnit] = useState('cái');
  const [newProdStock, setNewProdStock] = useState('0');
  const [newProdSellPrice, setNewProdSellPrice] = useState('');
  const [newProdImportPrice, setNewProdImportPrice] = useState('');
  const [addProdError, setAddProdError] = useState('');

  // Manual input edit
  const [manualText, setManualText] = useState('');

  // Refs
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isListeningRef = useRef(isListening);
  isListeningRef.current = isListening;
  const handleTranscriptRef = useRef<(text: string, isFinal?: boolean) => void>(() => {});
  // Hành động gần nhất: dùng cho đoạn nói không có từ "bán"/"nhập" (vd: "1 chai aquafina - ghi")
  const lastActionRef = useRef<'NHAP' | 'BAN'>('BAN');
  const commitRef = useRef<(parsed: ParsedVoiceResult) => void>(() => {});
  // Giỏ chờ: gom MỌI câu nói (kể cả khi nhận dạng giọng nói tách thành nhiều đoạn) cho tới khi nói "ghi"
  const pendingRef = useRef<ParsedVoiceResult[]>([]);

  // Lấy tồn kho hiện tại của một sản phẩm
  const getProductStock = (productName: string, unit: string): number => {
    const item = inventory.find(
      (i) =>
        i.productName.trim().toLowerCase() === productName.trim().toLowerCase() &&
        i.unit.trim().toLowerCase() === unit.trim().toLowerCase()
    );
    return item ? item.currentStock : 0;
  };

  // Kiểm tra bán quá tồn
  const isOversell = (parsed: ParsedVoiceResult | null): boolean => {
    if (!parsed || parsed.action !== 'BAN' || parsed.quantity === null) return false;
    const currentStock = getProductStock(parsed.productName, parsed.unit);
    return currentStock - parsed.quantity < 0;
  };

  // --- Show Toast Helper ---
  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success', undoTxId?: string) => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    setStatusToast({ message, type, undoTxId });
    // Nếu có undoTxId, toast xuất hiện 8 giây như yêu cầu; nếu không thì 4 giây
    const duration = undoTxId ? 8000 : 4000;
    toastTimeoutRef.current = setTimeout(() => {
      setStatusToast(null);
    }, duration);
  };

  // --- Danh mục sản phẩm ---
  const saveCatalog = (items: CatalogItem[]) => {
    const stamp = new Date().toLocaleString('vi-VN');
    setCatalog(items);
    setCatalogUpdated(stamp);
    try {
      localStorage.setItem('voicestock_catalog', JSON.stringify(items));
      localStorage.setItem('voicestock_catalog_updated', stamp);
    } catch {
      /* bộ nhớ đầy: bỏ qua, vẫn dùng được trong phiên này */
    }
    pushServerSync({ catalog: items, catalogUpdated: stamp }).then((r) => {
      if (r?.data?.updatedAt) lastServerTimestampRef.current = r.data.updatedAt;
    });
  };

  const loadCatalogFromSheets = async (silent: boolean = false) => {
    const url = (settings.googleSheetsWebhook || '').trim();
    if (!url) {
      if (!silent) showToast('Vui lòng nhập URL Webhook Google Sheets trong Cài đặt trước.', 'error');
      return;
    }
    setCatalogLoading(true);
    try {
      // GET đơn giản (không no-cors, không headers) để đọc được phản hồi
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'action=catalog');
      const data = await res.json();
      if (data && data.status === 'success' && Array.isArray(data.items)) {
        saveCatalog(data.items as CatalogItem[]);
        setCatalogError(false);
        if (!silent) showToast(`Đã tải ${data.items.length} sản phẩm từ Google Sheet.`, 'success');
      } else {
        throw new Error((data && data.message) || 'Phản hồi không đúng định dạng');
      }
    } catch {
      setCatalogError(true);
      if (!silent) {
        showToast('Không tải được danh mục từ Sheet. Hãy dùng nút "Nhập danh mục từ file CSV".', 'error');
      }
    } finally {
      setCatalogLoading(false);
    }
  };

  const handleCatalogCsv = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const items = parseCatalogCsv(await file.text());
      if (items.length === 0) {
        showToast('File CSV không có sản phẩm nào đọc được.', 'error');
        return;
      }
      saveCatalog(items);
      setCatalogError(false);
      showToast(`Đã nhập ${items.length} sản phẩm từ file.`, 'success');
    } catch {
      showToast('Không đọc được file CSV.', 'error');
    }
  };

  // Luôn trỏ tới bản mới nhất của hàm tải (để dùng trong sự kiện/đồng hồ chỉ đăng ký một lần)
  const loadCatalogRef = useRef<(silent?: boolean) => void>(() => {});
  loadCatalogRef.current = loadCatalogFromSheets;

  // Tự tải danh mục khi mở app, khi quay lại màn hình app (tối đa 30 giây một lần) và mỗi 5 phút,
  // để giá sửa trong Google Sheet luôn được cập nhật vào app.
  useEffect(() => {
    let lastRefresh = Date.now();
    const refresh = (force: boolean) => {
      if (document.visibilityState === 'hidden') return;
      if (!force && Date.now() - lastRefresh < 30000) return;
      lastRefresh = Date.now();
      loadCatalogRef.current(true);
    };
    refresh(true);
    const onVisible = () => refresh(false);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => refresh(true), 5 * 60 * 1000);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, []);

  // --- Save to LocalStorage ---
  useEffect(() => {
    try {
      localStorage.setItem('voicestock_inventory', JSON.stringify(inventory));
    } catch (e) {
      console.warn('Lỗi lưu inventory:', e);
    }
  }, [inventory]);

  useEffect(() => {
    try {
      localStorage.setItem('voicestock_history', JSON.stringify(history));
    } catch (e) {
      console.warn('Lỗi lưu history:', e);
    }
  }, [history]);

  useEffect(() => {
    try {
      localStorage.setItem('voicestock_settings', JSON.stringify(settings));
    } catch (e) {
      console.warn('Lỗi lưu settings:', e);
    }
  }, [settings]);

  // --- Tự động đồng bộ 2 chiều Máy tính ⇄ Điện thoại qua Server API ---
  const syncWithServer = async (silent: boolean = true) => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    setSyncStatus('syncing');
    try {
      const res = await fetchServerSync();
      if (res.success && res.data) {
        const data = res.data;
        const srvTime = data.updatedAt || 0;

        if (srvTime > lastServerTimestampRef.current) {
          lastServerTimestampRef.current = srvTime;
          if (Array.isArray(data.inventory)) {
            setInventory(data.inventory);
          }
          if (Array.isArray(data.history)) {
            setHistory(data.history);
          }
          if (data.settings) {
            setSettings((prev) => ({ ...prev, ...data.settings }));
          }
          if (Array.isArray(data.catalog) && data.catalog.length > 0) {
            setCatalog(data.catalog);
            if (data.catalogUpdated) setCatalogUpdated(data.catalogUpdated);
          }
        } else if (srvTime === 0 && (inventory.length > 0 || history.length > 0 || settings.googleSheetsWebhook)) {
          // Khởi tạo máy chủ nếu server mới chạy và chưa có dữ liệu
          const pushRes = await pushServerSync({
            inventory,
            history,
            settings,
            catalog,
            catalogUpdated,
          });
          if (pushRes.data?.updatedAt) {
            lastServerTimestampRef.current = pushRes.data.updatedAt;
          }
        }
        setSyncStatus('synced');
        setLastSyncTime(new Date().toLocaleTimeString('vi-VN'));
        if (!silent) {
          showToast('Đã đồng bộ dữ liệu mới nhất thành công!', 'success');
        }
      } else {
        setSyncStatus('offline');
      }
    } catch {
      setSyncStatus('offline');
    } finally {
      isSyncingRef.current = false;
    }
  };

  const syncRef = useRef(syncWithServer);
  syncRef.current = syncWithServer;

  // Chu kỳ đồng bộ định kỳ mỗi 4 giây & khi quay lại màn hình
  useEffect(() => {
    syncRef.current(true);
    const interval = setInterval(() => {
      syncRef.current(true);
    }, 4000);

    const onActive = () => {
      if (document.visibilityState !== 'hidden') {
        syncRef.current(true);
      }
    };
    window.addEventListener('focus', onActive);
    document.addEventListener('visibilitychange', onActive);

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onActive);
      document.removeEventListener('visibilitychange', onActive);
    };
  }, []);

  // --- Initialize Web Speech API ---
  useEffect(() => {
    const SpeechRecognitionClass =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      setSpeechSupported(false);
      return;
    }

    try {
      const recognition = new SpeechRecognitionClass();
      recognition.lang = 'vi-VN';
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onstart = () => {
        setIsListening(true);
        if (settings.beepSoundEnabled) {
          playSoundTone('start');
        }
      };

      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        let interimText = '';
        let finalText = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const trans = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalText += trans;
          } else {
            interimText += trans;
          }
        }

        const fullText = (finalText || interimText).trim();
        const hasFinal = Boolean(finalText.trim());

        if (fullText) {
          setLiveTranscript(fullText);
          handleTranscriptRef.current(fullText, hasFinal);
        }
      };

      recognition.onerror = (event: { error: string }) => {
        console.warn('SpeechRecognition error:', event.error);
        if (event.error !== 'no-speech') {
          setIsListening(false);
        }
      };

      recognition.onend = () => {
        if (isListeningRef.current) {
          try {
            recognition.start();
          } catch {
            setIsListening(false);
          }
        } else {
          setIsListening(false);
        }
      };

      recognitionRef.current = recognition;
    } catch (err) {
      console.error('Không thể khởi tạo SpeechRecognition:', err);
      setSpeechSupported(false);
    }

    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
      }
    };
  }, [settings.beepSoundEnabled]);

  // --- Toggle Speech Recognition ---
  const toggleRecording = () => {
    if (!speechSupported) {
      showToast('Trình duyệt của bạn không hỗ trợ Web Speech API. Vui lòng nhập bằng ô gõ bên dưới.', 'error');
      return;
    }

    if (!recognitionRef.current) return;

    if (isListening) {
      isListeningRef.current = false;
      setIsListening(false);
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    } else {
      isListeningRef.current = true;
      try {
        recognitionRef.current.start();
      } catch {
        try {
          recognitionRef.current.stop();
          setTimeout(() => {
            recognitionRef.current?.start();
          }, 150);
        } catch (e) {
          console.error(e);
        }
      }
    }
  };

  // --- Clear Auto Save Timer ---
  const clearAutoSaveTimer = () => {
    if (autoSaveTimerRef.current) {
      clearInterval(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    setAutoSaveRemaining(null);
  };

  const startAutoSaveTimer = (_currentParsed: ParsedVoiceResult) => {
    // Đã bỏ qua tự động xác nhận sau 3 giây theo yêu cầu
    clearAutoSaveTimer();
  };

  // Giữ giỏ chờ khớp với state (khi người dùng sửa / hủy / chọn mặt hàng trên màn hình)
  useEffect(() => {
    pendingRef.current = parsedBatch.length > 0 ? parsedBatch : parsedResult ? [parsedResult] : [];
  }, [parsedBatch, parsedResult]);

  // Đặt giỏ chờ: 1 dòng -> thẻ đơn, nhiều dòng -> thẻ gom
  const setPending = (items: ParsedVoiceResult[]) => {
    pendingRef.current = items;
    setParsedResult(items.length === 1 ? items[0] : null);
    setParsedBatch(items.length > 1 ? items : []);
  };

  // Bỏ một dòng khỏi giỏ chờ
  const removePendingItem = (idx: number) => {
    setPending(pendingRef.current.filter((_, i) => i !== idx));
  };

  // --- Handle Transcript & NLP Parsing ---
  // Chỉ xử lý khi kết quả giọng nói đã chốt (isFinal = true).
  // Một lệnh có thể chứa nhiều mặt hàng, ngăn cách bằng " - " hoặc dấu phẩy.
  // Cuối lệnh: "ghi" = lưu ngay, "đọc" = đọc lại, "đọc ghi" = đọc rồi lưu.
  const handleTranscriptReceived = (text: string, isFinal: boolean = false) => {
    if (!isFinal) {
      return;
    }

    const multi = parseVietnameseMulti(text, lastActionRef.current);
    const prepared = multi.items.map((raw) => {
      // Khớp tên với danh mục; chưa có danh mục thì dùng giá theo kho như cũ
      const resolved = resolveWithCatalog(raw, catalog);
      return resolved.matchStatus === 'no_catalog' ? applyAutoPrice(resolved, inventory) : resolved;
    });

    // Chỉ nói "ghi" / "đọc" mà không có mặt hàng: áp dụng cho cả giỏ đang chờ
    if (prepared.length === 0) {
      const pending = pendingRef.current;
      if (multi.saveRequested && pending.length > 0) {
        commitBatch(pending, multi.readRequested);
      } else if (multi.readRequested && pending.length > 0 && settings.voiceFeedbackEnabled) {
        speakVietnamese(
          buildSpokenReadBack(pending.map((p) => ({ type: p.action, quantity: p.quantity, unit: p.unit, productName: p.productName, totalPrice: p.totalPrice })), true),
          settings.speechRate
        );
      }
      return;
    }

    // GOM LỆNH: cộng dồn vào giỏ chờ (cùng mặt hàng, cùng giá thì cộng số lượng)
    const merged = mergePendingItems(pendingRef.current, prepared);
    const allReady = merged.every((p) => p.isValid && p.matchStatus !== 'ambiguous');

    if (multi.saveRequested && allReady) {
      commitBatch(merged, multi.readRequested);
      return;
    }

    // Chưa ghi: hiển thị cả giỏ để kiểm tra, chờ nói "ghi"
    setPending(merged);

    if (multi.readRequested && settings.voiceFeedbackEnabled) {
      speakVietnamese(
        buildSpokenReadBack(merged.map((p) => ({ type: p.action, quantity: p.quantity, unit: p.unit, productName: p.productName, totalPrice: p.totalPrice })), true),
        settings.speechRate
      );
    }

    if (allReady && settings.beepSoundEnabled) {
      playSoundTone('countdown');
    }
  };

  // --- Commit Transaction & Save ---
  // Ghi một hoặc nhiều mặt hàng. Các mặt hàng trong cùng lệnh dùng chung một Mã Lô.
  // Tính tồn kho lần lượt trên một bản sao để không mất mặt hàng nào trong lệnh.
  const commitBatch = async (rawItems: ParsedVoiceResult[], readBack: boolean = false) => {
    clearAutoSaveTimer();
    const prepared = rawItems.map((p) => (p.matchStatus ? p : applyAutoPrice(p, inventory)));
    const valid = prepared.filter(
      (p) => p.isValid && p.action && p.quantity && p.productName && p.matchStatus !== 'ambiguous'
    );

    if (valid.length === 0 || valid.length !== prepared.length) {
      showToast('Thông tin chưa đầy đủ để lưu giao dịch!', 'error');
      return;
    }

    const now = new Date();
    const formattedTime = formatDateTime(now.toISOString());
    const batchId = 'B' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const isBatch = valid.length > 1;

    const newList = [...inventory];
    const newTxs: Transaction[] = [];
    const updatedItems: InventoryItem[] = [];

    for (const p of valid) {
      const newTx: Transaction = {
        id: 'TX' + Math.random().toString(36).substring(2, 8).toUpperCase(),
        batchId,
        timestamp: now.toISOString(),
        formattedTime,
        type: p.action as TransactionType,
        productName: p.productName,
        quantity: p.quantity as number,
        unit: p.unit || 'cái',
        unitPrice: p.unitPrice || undefined,
        totalPrice: p.totalPrice || undefined,
        priceAuto: p.priceAuto === true ? true : undefined,
        rawTranscript: p.rawTranscript || liveTranscript || '',
        syncedSheets: false,
        sheetsSyncStatus: settings.googleSheetsWebhook ? 'sent_unconfirmed' : 'not_sent',
        syncedTelegram: false,
      };

      const matchIndex = newList.findIndex(
        (item) =>
          item.productName.trim().toLowerCase() === newTx.productName.trim().toLowerCase() &&
          item.unit.trim().toLowerCase() === newTx.unit.trim().toLowerCase()
      );

      let updatedItem: InventoryItem;
      if (matchIndex >= 0) {
        const current = newList[matchIndex];
        const newImport = current.totalImport + (newTx.type === 'NHAP' ? newTx.quantity : 0);
        const newExport = current.totalExport + (newTx.type === 'BAN' ? newTx.quantity : 0);
        updatedItem = {
          ...current,
          totalImport: newImport,
          totalExport: newExport,
          currentStock: newImport - newExport,
          lastUpdated: now.toISOString(),
        };
        newList[matchIndex] = updatedItem;
      } else {
        const newImport = newTx.type === 'NHAP' ? newTx.quantity : 0;
        const newExport = newTx.type === 'BAN' ? newTx.quantity : 0;
        updatedItem = {
          productName: newTx.productName,
          unit: newTx.unit,
          totalImport: newImport,
          totalExport: newExport,
          currentStock: newImport - newExport,
          lastUpdated: now.toISOString(),
        };
        newList.unshift(updatedItem);
      }

      newTxs.push(newTx);
      updatedItems.push(updatedItem);
    }

    lastActionRef.current = valid[valid.length - 1].action as 'NHAP' | 'BAN';

    // Cập nhật tồn kho và lịch sử
    setInventory(newList);
    const updatedHistory = [...newTxs, ...history];
    setHistory(updatedHistory);

    pushServerSync({ history: updatedHistory, inventory: newList }).then((r) => {
      if (r?.data?.updatedAt) lastServerTimestampRef.current = r.data.updatedAt;
    });

    // Âm thanh & đọc xác nhận (câu cuối luôn đọc thành tiền)
    if (settings.beepSoundEnabled) {
      playSoundTone('success');
    }
    if (settings.voiceFeedbackEnabled) {
      speakVietnamese(
        buildSpokenReadBack(
          newTxs.map((t) => ({ type: t.type, quantity: t.quantity, unit: t.unit, productName: t.productName, totalPrice: t.totalPrice })),
          readBack
        ),
        settings.speechRate
      );
    }

    // 4. Đồng bộ Google Sheets (mỗi mặt hàng một dòng, cùng Mã Lô)
    if (settings.googleSheetsWebhook) {
      const ids = newTxs.map((t) => t.id);
      syncBatchToGoogleSheets(settings.googleSheetsWebhook, newTxs).then((res) => {
        const nextStatus = res.success ? 'sent_unconfirmed' : 'failed';
        setHistory((prev) =>
          prev.map((x) => (ids.includes(x.id) ? { ...x, sheetsSyncStatus: nextStatus } : x))
        );
      });
    }

    // 5. Gửi thông báo Telegram Bot trực tiếp
    if (settings.telegramBotToken && settings.telegramChatId) {
      const tgText =
        newTxs.length > 1
          ? buildTelegramBatchText(newTxs)
          : buildTelegramTransactionText(newTxs[0], updatedItems[0]);
      sendTelegramMessage(settings.telegramBotToken, settings.telegramChatId, tgText).then((res) => {
        if (res.success) {
          const ids = newTxs.map((t) => t.id);
          setHistory((prev) =>
            prev.map((x) => (ids.includes(x.id) ? { ...x, syncedTelegram: true } : x))
          );
        } else {
          console.warn('Lỗi gửi Telegram:', res.message);
        }
      });
    }

    // Thông báo và reset
    const sum = newTxs.reduce((acc, t) => acc + (t.totalPrice || 0), 0);
    if (isBatch) {
      showToast(`Đã lưu ${newTxs.length} mặt hàng · tổng ${formatVND(sum)}`, 'success');
    } else {
      const t = newTxs[0];
      showToast(
        `Đã lưu: ${t.type === 'NHAP' ? 'Nhập' : 'Bán'} ${t.quantity} ${t.unit} ${t.productName}!`,
        'success',
        t.id
      );
    }
    pendingRef.current = [];
    setParsedResult(null);
    setParsedBatch([]);
    setLiveTranscript('');

    // Mã QR thanh toán: đơn BÁN có tiền và đã cài đặt ngân hàng
    const saleTxs = newTxs.filter((t) => t.type === 'BAN');
    const saleSum = saleTxs.reduce((acc, t) => acc + (t.totalPrice || 0), 0);
    const bankReady =
      Boolean(settings.bankId && settings.bankId.trim()) &&
      Boolean(settings.bankAccountNo && settings.bankAccountNo.trim());
    if (bankReady && saleSum > 0 && saleTxs.length === newTxs.length) {
      if (isBatch) {
        setQrTx({
          ...newTxs[0],
          id: batchId,
          productName: `${newTxs.length} mặt hàng`,
          quantity: 1,
          unit: 'đơn',
          totalPrice: saleSum,
        });
      } else {
        setQrTx(newTxs[0]);
      }
    }
  };

  const commitTransaction = (parsed: ParsedVoiceResult) => commitBatch([parsed], false);

  handleTranscriptRef.current = handleTranscriptReceived;
  commitRef.current = commitTransaction;

  // --- Cập nhật giá bán / giá nhập trực tiếp trong Tab Tồn kho (Yêu cầu 5) ---
  const handleUpdatePrice = (
    productName: string,
    unit: string,
    field: 'sellPrice' | 'importPrice',
    newPrice: number
  ) => {
    const normName = normalizeVietnameseText(productName);
    const normUnit = normalizeVietnameseText(unit);

    const updated = inventory.map((item) => {
      if (
        normalizeVietnameseText(item.productName) === normName &&
        normalizeVietnameseText(item.unit) === normUnit
      ) {
        return {
          ...item,
          [field]: newPrice >= 0 ? newPrice : 0,
          lastUpdated: new Date().toISOString(),
        };
      }
      return item;
    });

    setInventory(updated);
    try {
      localStorage.setItem('voicestock_inventory', JSON.stringify(updated));
    } catch (e) {
      console.warn('Lỗi lưu inventory:', e);
    }
    pushServerSync({ inventory: updated }).then((r) => {
      if (r?.data?.updatedAt) lastServerTimestampRef.current = r.data.updatedAt;
    });
  };

  // --- Thêm sản phẩm mới vào danh mục kho (Yêu cầu 6) ---
  const handleCreateProduct = (e: React.FormEvent) => {
    e.preventDefault();
    const trimName = newProdName.trim();
    const trimUnit = newProdUnit.trim() || 'cái';

    if (!trimName) {
      setAddProdError('Vui lòng nhập tên sản phẩm.');
      return;
    }

    const normName = normalizeVietnameseText(trimName);
    const normUnit = normalizeVietnameseText(trimUnit);

    const exists = inventory.some(
      (item) =>
        normalizeVietnameseText(item.productName) === normName &&
        normalizeVietnameseText(item.unit) === normUnit
    );

    if (exists) {
      setAddProdError(`Sản phẩm "${trimName}" với đơn vị "${trimUnit}" đã tồn tại trong kho.`);
      return;
    }

    const initStock = Math.max(0, parseFloat(newProdStock) || 0);
    const sellP = newProdSellPrice ? Math.max(0, parseFloat(newProdSellPrice) || 0) : 0;
    const importP = newProdImportPrice ? Math.max(0, parseFloat(newProdImportPrice) || 0) : 0;

    const newItem: InventoryItem = {
      productName: trimName,
      unit: trimUnit,
      totalImport: initStock,
      totalExport: 0,
      currentStock: initStock,
      lastUpdated: new Date().toISOString(),
      sellPrice: sellP,
      importPrice: importP,
    };

    const updated = [newItem, ...inventory];
    setInventory(updated);
    try {
      localStorage.setItem('voicestock_inventory', JSON.stringify(updated));
    } catch (err) {
      console.warn('Lỗi lưu inventory:', err);
    }
    pushServerSync({ inventory: updated }).then((r) => {
      if (r?.data?.updatedAt) lastServerTimestampRef.current = r.data.updatedAt;
    });

    showToast(`Đã thêm sản phẩm "${trimName}" (${trimUnit}) vào kho!`, 'success');
    setShowAddProductModal(false);
  };

  // --- Xóa / Hoàn tác từng giao dịch (Yêu cầu 4) ---
  const deleteTransaction = (id: string, confirmFirst: boolean = true) => {
    const tx = history.find((h) => h.id === id);
    if (!tx) return;

    if (confirmFirst) {
      const ok = window.confirm(
        `Bạn có chắc muốn xóa giao dịch: ${tx.type === 'NHAP' ? 'Nhập' : 'Bán'} ${tx.quantity} ${tx.unit} "${tx.productName}"?\n\nTồn kho sẽ được tự động hoàn lại tương ứng.`
      );
      if (!ok) return;
    }

    // Đảo ngược ảnh hưởng lên tồn kho:
    // Xóa NHAP thì trừ totalImport, xóa BAN thì trừ totalExport, tính lại currentStock
    const updatedInventory = inventory.map((item) => {
      if (
        item.productName.trim().toLowerCase() === tx.productName.trim().toLowerCase() &&
        item.unit.trim().toLowerCase() === tx.unit.trim().toLowerCase()
      ) {
        const newImport = tx.type === 'NHAP' ? Math.max(0, item.totalImport - tx.quantity) : item.totalImport;
        const newExport = tx.type === 'BAN' ? Math.max(0, item.totalExport - tx.quantity) : item.totalExport;
        return {
          ...item,
          totalImport: newImport,
          totalExport: newExport,
          currentStock: newImport - newExport,
          lastUpdated: new Date().toISOString(),
        };
      }
      return item;
    });
    setInventory(updatedInventory);

    const updatedHistory = history.filter((h) => h.id !== id);
    setHistory(updatedHistory);
    pushServerSync({ inventory: updatedInventory, history: updatedHistory }).then((r) => {
      if (r?.data?.updatedAt) lastServerTimestampRef.current = r.data.updatedAt;
    });
    showToast(`Đã xóa giao dịch ${id} và hoàn lại tồn kho thành công!`, 'info');
  };

  // --- Gửi lại tới Google Sheets ---
  const handleResendSheets = async (tx: Transaction) => {
    if (!settings.googleSheetsWebhook) {
      showToast('Vui lòng nhập URL Webhook Google Sheets trong Cài đặt trước.', 'error');
      return;
    }
    const item = inventory.find(
      (i) =>
        i.productName.trim().toLowerCase() === tx.productName.trim().toLowerCase() &&
        i.unit.trim().toLowerCase() === tx.unit.trim().toLowerCase()
    );
    const res = await syncToGoogleSheets(settings.googleSheetsWebhook, tx, item);
    const nextStatus = res.success ? 'sent_unconfirmed' : 'failed';
    setHistory((prev) =>
      prev.map((t) => (t.id === tx.id ? { ...t, sheetsSyncStatus: nextStatus } : t))
    );
    if (res.success) {
      showToast(`Đã gửi lại giao dịch ${tx.id} tới Google Sheets (chưa xác nhận)!`, 'info');
    } else {
      showToast(`Gửi lại thất bại: ${res.message}`, 'error');
    }
  };

  // --- Gửi lại tới Telegram ---
  const handleResendTelegram = async (tx: Transaction) => {
    if (!settings.telegramBotToken || !settings.telegramChatId) {
      showToast('Vui lòng nhập Bot Token và Chat ID trong Cài đặt trước.', 'error');
      return;
    }
    const item = inventory.find(
      (i) =>
        i.productName.trim().toLowerCase() === tx.productName.trim().toLowerCase() &&
        i.unit.trim().toLowerCase() === tx.unit.trim().toLowerCase()
    );
    const tgText = buildTelegramTransactionText(tx, item);
    const res = await sendTelegramMessage(settings.telegramBotToken, settings.telegramChatId, tgText);
    if (res.success) {
      setHistory((prev) =>
        prev.map((t) => (t.id === tx.id ? { ...t, syncedTelegram: true } : t))
      );
      showToast(`Đã gửi giao dịch ${tx.id} tới Telegram thành công!`, 'success');
    } else {
      showToast(`Gửi tới Telegram thất bại: ${res.message}`, 'error');
    }
  };

  // --- Hủy kết quả hiện tại ---
  const handleCancelResult = () => {
    clearAutoSaveTimer();
    pendingRef.current = [];
    setParsedResult(null);
    setParsedBatch([]);
    setLiveTranscript('');
  };

  // --- Thử nhanh câu lệnh mẫu ---
  const handleRunSampleCommand = (sample: string) => {
    setLiveTranscript(sample);
    // Nhấn câu lệnh mẫu là kết quả chốt (isFinal = true)
    handleTranscriptReceived(sample, true);
  };

  // --- Kiểm tra kết nối Google Sheets & ghi log debug ---
  const handleTestGoogleSheets = async () => {
    if (!settings.googleSheetsWebhook) {
      setTestSheetsStatus({
        loading: false,
        msg: 'Vui lòng nhập URL Webhook Google Apps Script trước khi kiểm tra.',
        success: false,
      });
      return;
    }

    setTestSheetsStatus({ loading: true, msg: 'Đang gửi tín hiệu kiểm tra tới Google Sheets...' });
    const res = await testGoogleSheetsConnection(settings.googleSheetsWebhook);
    setTestSheetsStatus({
      loading: false,
      msg: res.success ? `✅ ${res.message}` : `❌ ${res.message}`,
      success: res.success,
    });
  };

  // --- Gửi tin nhắn Telegram Test ---
  const handleTestTelegram = async () => {
    if (!settings.telegramBotToken || !settings.telegramChatId) {
      setTestTgStatus({
        loading: false,
        msg: 'Vui lòng điền đủ Bot Token và Chat ID trước khi bấm thử.',
        success: false,
      });
      return;
    }

    setTestTgStatus({ loading: true, msg: 'Đang gửi tin nhắn thử...' });
    const res = await sendTelegramMessage(
      settings.telegramBotToken,
      settings.telegramChatId,
      `🎉 <b>VoiceStock: Kết nối thành công!</b>\n\nTelegram Bot của bạn đã sẵn sàng nhận thông báo nhập/xuất kho tự động.\n⏰ Thời gian: ${new Date().toLocaleTimeString('vi-VN')}`
    );

    setTestTgStatus({
      loading: false,
      msg: res.success ? '✅ Gửi thành công! Hãy kiểm tra Telegram.' : `❌ ${res.message}`,
      success: res.success,
    });
  };

  // --- Tải xuống file HTML độc lập ---
  const handleDownloadStandaloneHtml = () => {
    const htmlContent = generateStandaloneHtml();
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'voicestock-single-file.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setCopiedDownload(true);
    setTimeout(() => setCopiedDownload(false), 3000);
    showToast('Đã tải xuống file HTML độc lập hoàn chỉnh! Bạn có thể mở trực tiếp trên mọi thiết bị.', 'success');
  };

  // --- Copy Google Apps Script Code ---
  const handleCopyGasCode = () => {
    navigator.clipboard.writeText(GOOGLE_APPS_SCRIPT_CODE);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2500);
    showToast('Đã sao chép mã nguồn Code.gs vào khay nhớ tạm!', 'success');
  };

  // --- Xuất CSV Lịch sử ---
  const handleExportHistoryCSV = () => {
    if (history.length === 0) {
      showToast('Chưa có dữ liệu lịch sử để xuất file.', 'error');
      return;
    }

    const headers = ['Mã GD', 'Thời Gian', 'Loại', 'Tên Sản Phẩm', 'Số Lượng', 'Đơn Vị', 'Đơn Giá', 'Thành Tiền', 'Lệnh Thoại'];
    const rows = history.map((t) => [
      t.id,
      t.formattedTime,
      t.type === 'NHAP' ? 'Nhập hàng' : 'Bán hàng',
      `"${t.productName.replace(/"/g, '""')}"`,
      t.quantity,
      t.unit,
      t.unitPrice || 0,
      t.totalPrice || 0,
      `"${t.rawTranscript.replace(/"/g, '""')}"`,
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lich-su-voicestock-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Đã xuất file CSV thành công!', 'success');
  };

  // --- Danh sách tồn kho sau khi lọc ---
  const filteredInventory = useMemo(() => {
    const q = stockSearch.trim().toLowerCase();
    if (!q) return inventory;
    return inventory.filter(
      (item) => item.productName.toLowerCase().includes(q) || item.unit.toLowerCase().includes(q)
    );
  }, [inventory, stockSearch]);

  // --- Danh sách lịch sử sau khi lọc ---
  const filteredHistory = useMemo(() => {
    return history.filter((t) => {
      const matchType = historyTypeFilter === 'ALL' || t.type === historyTypeFilter;
      const matchSearch =
        !historySearch ||
        t.productName.toLowerCase().includes(historySearch.toLowerCase()) ||
        t.rawTranscript.toLowerCase().includes(historySearch.toLowerCase());
      return matchType && matchSearch;
    });
  }, [history, historyTypeFilter, historySearch]);

  // Thống kê nhanh
  const stats = useMemo(() => {
    const totalItems = inventory.length;
    const lowStockCount = inventory.filter((i) => i.currentStock <= 5).length;
    const outOfStockCount = inventory.filter((i) => i.currentStock <= 0).length;
    const totalTransactions = history.length;
    return { totalItems, lowStockCount, outOfStockCount, totalTransactions };
  }, [inventory, history]);

  const oversellingCurrent = parsedResult?.matchStatus !== 'ambiguous' && isOversell(parsedResult);
  const currentAvailableStock = parsedResult ? getProductStock(parsedResult.productName, parsedResult.unit) : 0;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-white">
      {/* Toast Notification có nút Hoàn tác 8 giây (Yêu cầu 4) */}
      {statusToast && (
        <div
          className={`fixed top-4 right-4 z-50 flex items-center gap-2.5 px-4 py-3 rounded-2xl shadow-2xl border text-sm transition-all duration-300 animate-in fade-in slide-in-from-top-4 ${
            statusToast.type === 'success'
              ? 'bg-emerald-950/95 text-emerald-200 border-emerald-500/40 shadow-emerald-950/50'
              : statusToast.type === 'error'
              ? 'bg-rose-950/95 text-rose-200 border-rose-500/40 shadow-rose-950/50'
              : 'bg-slate-900/95 text-slate-200 border-slate-700 shadow-black/50'
          }`}
        >
          {statusToast.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          ) : (
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
          )}
          <span>{statusToast.message}</span>

          {/* Nút Hoàn tác xuất hiện trong toast sau khi lưu */}
          {statusToast.undoTxId && (
            <button
              onClick={() => {
                deleteTransaction(statusToast.undoTxId!, false);
                setStatusToast(null);
              }}
              className="ml-3 px-3 py-1 bg-white/20 hover:bg-white/30 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition active:scale-95 cursor-pointer shadow-sm"
              title="Hoàn tác và phục hồi lại tồn kho"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Hoàn tác</span>
            </button>
          )}
        </div>
      )}

      {/* Main Top Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-400 flex items-center justify-center text-slate-950 font-black text-xl shadow-lg shadow-emerald-500/25">
              🎙️
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-base sm:text-lg tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-300 bg-clip-text text-transparent">
                  VoiceStock
                </span>
                <span className="text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  Realtime NLP
                </span>
              </div>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                Quản lý Bán hàng & Tồn kho bằng Giọng nói tiếng Việt
              </p>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="flex items-center gap-2">
            {/* Nút Mở trên Điện thoại */}
            <button
              onClick={() => setShowMobileConnectModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-xs font-semibold border border-emerald-500/30 transition cursor-pointer"
              title="Quét mã QR để mở app trên điện thoại và đồng bộ ngay"
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Mở trên ĐT</span>
              <span className="sm:hidden">ĐT</span>
            </button>

            {/* Trạng thái Đồng bộ */}
            <button
              onClick={() => syncWithServer(false)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition cursor-pointer"
              title={lastSyncTime ? `Đồng bộ lần cuối: ${lastSyncTime}. Bấm để làm mới.` : 'Đồng bộ dữ liệu'}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncStatus === 'syncing' ? 'animate-spin text-amber-400' : syncStatus === 'synced' ? 'text-emerald-400' : 'text-slate-400'}`} />
              <span className="hidden md:inline">{syncStatus === 'syncing' ? 'Đang đồng bộ...' : 'Đồng bộ'}</span>
            </button>

            <button
              onClick={handleDownloadStandaloneHtml}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition"
              title="Tải về file HTML độc lập chạy 100% không cần server"
            >
              {copiedDownload ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Download className="w-3.5 h-3.5 text-emerald-400" />}
              <span>Xuất HTML độc lập</span>
            </button>

            <button
              onClick={() => setShowSettingsModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition relative"
            >
              <SettingsIcon className="w-3.5 h-3.5 text-slate-400" />
              <span>Cài đặt</span>
              {(settings.googleSheetsWebhook || settings.telegramBotToken) && (
                <span className="w-2 h-2 rounded-full bg-emerald-400 absolute -top-0.5 -right-0.5 ring-2 ring-slate-900" />
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {/* Navigation Tabs Bar */}
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-1 overflow-x-auto gap-4">
          <nav className="flex space-x-2 sm:space-x-4">
            <button
              onClick={() => setActiveTab('record')}
              className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-bold transition ${
                activeTab === 'record'
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <Mic className="w-4 h-4" />
              <span>Thu Âm & Bán Hàng</span>
            </button>

            <button
              onClick={() => setActiveTab('stock')}
              className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-bold transition relative ${
                activeTab === 'stock'
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <Package className="w-4 h-4" />
              <span>Bảng Tồn Kho</span>
              <span className="text-[11px] px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300">
                {stats.totalItems}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('history')}
              className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-bold transition ${
                activeTab === 'history'
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <HistoryIcon className="w-4 h-4" />
              <span>Lịch Sử Giao Dịch</span>
              <span className="text-[11px] px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300">
                {stats.totalTransactions}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('guide')}
              className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-bold transition ${
                activeTab === 'guide'
                  ? 'bg-teal-500/15 text-teal-300 border border-teal-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
              <span>Mã Code.gs & Hướng Dẫn</span>
            </button>
          </nav>
        </div>

        {/* ================= TAB 1: THU ÂM & BÁN HÀNG ================= */}
        {activeTab === 'record' && (
          <div className="space-y-6">
            {/* Trạng thái danh mục: cho biết vì sao giá có/không tự điền */}
            <div
              className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 rounded-xl border text-xs ${
                catalog.length > 0 && !catalogError
                  ? 'bg-emerald-950/30 border-emerald-800/40 text-emerald-200'
                  : 'bg-amber-950/40 border-amber-600/40 text-amber-200'
              }`}
              data-testid="catalog-status"
            >
              <span>
                {catalog.length > 0
                  ? `Danh mục: ${catalog.length} sản phẩm${catalogUpdated ? ' • cập nhật ' + catalogUpdated : ''}${
                      catalogError ? ' • lần tải gần nhất bị lỗi' : ''
                    }`
                  : catalogError
                  ? 'Chưa tải được danh mục từ Sheet nên giá sẽ KHÔNG tự điền.'
                  : 'Chưa có danh mục nên giá sẽ KHÔNG tự điền.'}
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => loadCatalogFromSheets(false)}
                  disabled={catalogLoading}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold cursor-pointer"
                >
                  {catalogLoading ? 'Đang tải...' : 'Tải lại'}
                </button>
                {(catalog.length === 0 || catalogError) && (
                  <button
                    type="button"
                    onClick={() => setShowSettingsModal(true)}
                    className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold cursor-pointer"
                  >
                    Nhập file CSV
                  </button>
                )}
              </span>
            </div>

            {/* Big Mic Hero Section */}
            <div className="relative rounded-3xl bg-gradient-to-b from-slate-900/90 to-slate-900/50 border border-slate-800/80 p-6 sm:p-10 text-center overflow-hidden shadow-2xl backdrop-blur">
              {/* Decorative radial background */}
              <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-emerald-500/10 blur-[100px] rounded-full pointer-events-none" />

              <div className="relative z-10 max-w-2xl mx-auto space-y-6">
                {/* Status indicator */}
                <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold tracking-wide bg-slate-800/90 border border-slate-700/80 shadow-inner">
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${
                      isListening ? 'bg-emerald-400 animate-ping' : 'bg-slate-500'
                    }`}
                  />
                  <span className={isListening ? 'text-emerald-300 font-bold' : 'text-slate-400'}>
                    {isListening ? 'Đang lắng nghe giọng nói...' : 'Micro: Sẵn sàng nhận lệnh'}
                  </span>
                </div>

                {/* Big Center Microphone Button */}
                <div className="py-2 flex flex-col items-center justify-center">
                  <div className="relative">
                    {/* Animated Pulsing Rings when recording */}
                    {isListening && (
                      <>
                        <div className="absolute inset-0 rounded-full bg-emerald-500/20 animate-ping opacity-75" />
                        <div className="absolute -inset-4 rounded-full border-2 border-emerald-500/40 animate-pulse" />
                        <div className="absolute -inset-8 rounded-full border border-emerald-500/20" />
                      </>
                    )}

                    <button
                      onClick={toggleRecording}
                      className={`relative z-10 w-28 h-28 sm:w-32 sm:h-32 rounded-full flex flex-col items-center justify-center gap-1.5 text-white shadow-2xl transition-all duration-300 active:scale-95 cursor-pointer ${
                        isListening
                          ? 'bg-gradient-to-tr from-rose-600 via-rose-500 to-red-500 shadow-rose-500/40 ring-4 ring-rose-400/30'
                          : 'bg-gradient-to-tr from-emerald-600 via-emerald-500 to-teal-400 shadow-emerald-500/30 hover:shadow-emerald-500/50 hover:scale-105 ring-4 ring-emerald-500/20'
                      }`}
                      aria-label="Thu âm giọng nói"
                    >
                      {isListening ? (
                        <>
                          <MicOff className="w-9 h-9 sm:w-10 sm:h-10 text-white animate-pulse" />
                          <span className="text-[11px] font-black uppercase tracking-wider">Đang Nghe</span>
                        </>
                      ) : (
                        <>
                          <Mic className="w-9 h-9 sm:w-10 sm:h-10 text-white" />
                          <span className="text-[11px] font-black uppercase tracking-wider">Bấm Để Nói</span>
                        </>
                      )}
                    </button>
                  </div>

                  {/* Audio wave effect */}
                  {isListening && (
                    <div className="flex items-center gap-1.5 mt-5 h-8">
                      <span className="w-1.5 bg-emerald-400 rounded-full animate-bounce [animation-delay:-0.3s] h-4" />
                      <span className="w-1.5 bg-emerald-400 rounded-full animate-bounce [animation-delay:-0.15s] h-7" />
                      <span className="w-1.5 bg-emerald-400 rounded-full animate-bounce h-5" />
                      <span className="w-1.5 bg-emerald-400 rounded-full animate-bounce [animation-delay:-0.2s] h-8" />
                      <span className="w-1.5 bg-emerald-400 rounded-full animate-bounce [animation-delay:-0.4s] h-4" />
                    </div>
                  )}
                </div>

                {/* Real-time Voice Transcript Box */}
                <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-4 sm:p-5 text-center shadow-inner min-h-[80px] flex items-center justify-center">
                  {liveTranscript ? (
                    <p className="text-base sm:text-lg text-emerald-300 font-semibold tracking-wide">
                      "{liveTranscript}"
                    </p>
                  ) : (
                    <p className="text-sm sm:text-base text-slate-500 italic">
                      Nhấn nút Micro và nói ví dụ: <span className="text-slate-400">"Tôi nhập 10 thùng mì tôm"</span> hoặc{' '}
                      <span className="text-slate-400">"Bán 2 chai nước tương chinsu giá 25k"</span>...
                    </p>
                  )}
                </div>

                {/* Batch Card: nhiều mặt hàng trong một lệnh */}
                {parsedBatch.length > 1 && (
                  <div className="bg-slate-850 border border-slate-700/80 rounded-2xl p-5 text-left space-y-3 shadow-xl">
                    <div className="flex items-center justify-between border-b border-slate-700/60 pb-3">
                      <span className="text-xs font-bold text-slate-300 uppercase tracking-wide">
                        Đơn đang gom · {parsedBatch.length} mặt hàng (nói "ghi" để lưu)
                      </span>
                      <button
                        onClick={handleCancelResult}
                        className="text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
                      >
                        Hủy
                      </button>
                    </div>
                    <ul className="space-y-2">
                      {parsedBatch.map((p, idx) => (
                        <li key={idx} className="flex items-center justify-between gap-3 text-sm">
                          <span className={p.isValid ? 'text-white truncate' : 'text-rose-300 truncate'}>
                            {p.action === 'NHAP' ? 'Nhập' : p.action === 'BAN' ? 'Bán' : '?'}{' '}
                            {p.quantity ?? '?'} {p.unit} {p.productName || '(chưa rõ tên)'}
                          </span>
                          <span className="flex items-center gap-2 text-slate-300 whitespace-nowrap">
                            {p.totalPrice ? formatVND(p.totalPrice) : <span className="text-slate-500">Không có giá</span>}
                            <button
                              onClick={() => removePendingItem(idx)}
                              title="Bỏ dòng này"
                              className="text-slate-500 hover:text-rose-400 cursor-pointer px-1"
                            >
                              ✕
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="flex items-center justify-between pt-2 border-t border-slate-700/60">
                      <span className="text-xs text-slate-400">Thành tiền</span>
                      <span className="text-base font-bold text-white">
                        {formatVND(parsedBatch.reduce((acc, p) => acc + (p.totalPrice || 0), 0))}
                      </span>
                    </div>
                    <button
                      onClick={() => commitBatch(parsedBatch, true)}
                      disabled={!parsedBatch.every((p) => p.isValid && p.matchStatus !== 'ambiguous')}
                      className={`w-full py-3 px-4 rounded-xl font-bold text-sm transition ${
                        parsedBatch.every((p) => p.isValid && p.matchStatus !== 'ambiguous')
                          ? 'bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer'
                          : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                      }`}
                    >
                      Ghi tất cả {parsedBatch.length} mặt hàng
                    </button>
                  </div>
                )}

                {/* Parsed Result Card */}
                {parsedResult && (
                  <div className="bg-slate-850 border border-slate-700/80 rounded-2xl p-5 text-left space-y-4 shadow-xl animate-in fade-in zoom-in-95">
                    {/* Header with Badges & Countdown */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700/60 pb-3">
                      <div className="flex items-center gap-2">
                        {parsedResult.action === 'NHAP' ? (
                          <span className="px-3 py-1 rounded-full text-xs font-black tracking-wider uppercase bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center gap-1">
                            <ArrowDownLeft className="w-3.5 h-3.5" /> NHẬP HÀNG
                          </span>
                        ) : parsedResult.action === 'BAN' ? (
                          <span className="px-3 py-1 rounded-full text-xs font-black tracking-wider uppercase bg-amber-500/20 text-amber-400 border border-amber-500/40 flex items-center gap-1">
                            <ArrowUpRight className="w-3.5 h-3.5" /> BÁN HÀNG
                          </span>
                        ) : (
                          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-slate-800 text-slate-400">
                            Chưa rõ hành động
                          </span>
                        )}

                        <span className="text-xs text-slate-400">Bóc tách tự động:</span>
                      </div>

                      {/* Trạng thái xác nhận (bỏ qua tự động lưu, chỉ kích hoạt khi đã chốt và đủ tồn kho) */}
                      <div className="flex items-center gap-2">
                        {oversellingCurrent ? (
                          <span className="text-xs font-bold text-amber-400 bg-amber-500/10 px-3 py-1 rounded-full border border-amber-500/30 flex items-center gap-1.5">
                            <AlertCircle className="w-3.5 h-3.5" />
                            Tồn kho không đủ
                          </span>
                        ) : parsedResult.isValid ? (
                          <span className="text-xs font-bold text-emerald-400 bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/30 flex items-center gap-1.5">
                            <Check className="w-3.5 h-3.5" />
                            Đã chốt giọng nói • Nhấn nút bên dưới để lưu
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400 italic">
                            Chưa đủ thông tin sản phẩm
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Result Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div className="bg-slate-900/80 p-3.5 rounded-xl border border-slate-800">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[11px] font-medium text-slate-400">Tên Sản Phẩm</span>
                          {parsedResult.matchStatus === 'matched' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/30">
                              Đúng danh mục
                            </span>
                          )}
                          {parsedResult.matchStatus === 'unknown' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                              Chưa có trong danh mục
                            </span>
                          )}
                        </div>
                        <div className="text-base font-bold text-white mt-0.5 truncate" title={parsedResult.productName}>
                          {parsedResult.productName || <span className="text-slate-500 font-normal">Chưa rõ</span>}
                        </div>
                      </div>

                      <div className="bg-slate-900/80 p-3.5 rounded-xl border border-slate-800">
                        <span className="text-[11px] font-medium text-slate-400">Số Lượng & Đơn Vị</span>
                        <div className="text-base font-bold text-emerald-400 mt-0.5">
                          {parsedResult.quantity ? `${parsedResult.quantity} ${parsedResult.unit}` : <span className="text-slate-500 font-normal">Chưa rõ</span>}
                        </div>
                        {parsedResult.unitNote && (
                          <div className="text-[10px] text-amber-300 mt-1">{parsedResult.unitNote}</div>
                        )}
                      </div>

                      <div className="bg-slate-900/80 p-3.5 rounded-xl border border-slate-800">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[11px] font-medium text-slate-400">Đơn Giá</span>
                          {parsedResult.priceAuto && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/30">
                              Giá tự điền
                            </span>
                          )}
                        </div>
                        <div className="text-base font-semibold text-slate-200 mt-0.5">
                          {parsedResult.unitPrice ? formatVND(parsedResult.unitPrice) : (
                            <span className="text-slate-500 font-normal text-sm">
                              {parsedResult.matchStatus === 'no_catalog'
                                ? 'Chưa có danh mục'
                                : parsedResult.matchStatus === 'ambiguous'
                                ? 'Chọn sản phẩm trước'
                                : parsedResult.matchStatus === 'unknown'
                                ? 'SP chưa có trong danh mục'
                                : parsedResult.matchStatus === 'matched' && parsedResult.unitNote
                                ? 'Khác đơn vị danh mục'
                                : parsedResult.matchStatus === 'matched'
                                ? 'Danh mục chưa có giá'
                                : 'Không có'}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="bg-slate-900/80 p-3.5 rounded-xl border border-slate-800">
                        <span className="text-[11px] font-medium text-slate-400">Thành Tiền</span>
                        <div className="text-base font-bold text-amber-300 mt-0.5">
                          {parsedResult.totalPrice ? formatVND(parsedResult.totalPrice) : <span className="text-slate-500 font-normal">Không có</span>}
                        </div>
                      </div>
                    </div>

                    {/* Nhiều sản phẩm phù hợp: người dùng chọn đúng sản phẩm */}
                    {parsedResult.matchStatus === 'ambiguous' && parsedResult.candidates && (
                      <div className="p-3.5 bg-sky-950/60 border border-sky-500/40 rounded-xl text-xs text-sky-100 space-y-2">
                        <div className="font-semibold">Chọn đúng sản phẩm:</div>
                        <div className="flex flex-col gap-2">
                          {parsedResult.candidates.map((c) => (
                            <button
                              key={c.name + c.unit}
                              type="button"
                              onClick={() => setParsedResult((prev) => (prev ? chooseCatalogItem(prev, c) : prev))}
                              className="text-left px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-100 font-medium transition cursor-pointer"
                            >
                              {c.name} • {c.unit} • {c.sellPrice ? formatVND(c.sellPrice) : 'chưa có giá'}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Cảnh báo Bán Quá Tồn (Yêu cầu 3) */}
                    {oversellingCurrent && (
                      <div className="p-3.5 bg-amber-950/70 border border-amber-500/50 rounded-xl text-xs text-amber-200 space-y-2">
                        <div className="flex items-center gap-2 font-medium">
                          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                          <span>
                            Tồn kho chỉ còn <b>{currentAvailableStock} {parsedResult.unit}</b>, bạn muốn bán <b>{parsedResult.quantity} {parsedResult.unit}</b>?
                          </span>
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={handleCancelResult}
                            className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition cursor-pointer"
                          >
                            Hủy
                          </button>
                          <button
                            onClick={() => commitTransaction(parsedResult)}
                            className="px-3.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold transition shadow-sm cursor-pointer"
                          >
                            Vẫn lưu
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Error message if invalid */}
                    {!parsedResult.isValid && parsedResult.errorMessage && (
                      <div className="p-3 bg-rose-950/40 border border-rose-800/60 rounded-xl text-xs text-rose-300 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span>{parsedResult.errorMessage}</span>
                      </div>
                    )}

                    {/* Action buttons (khi không bị cảnh báo bán quá tồn) */}
                    {!oversellingCurrent && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          onClick={() => commitTransaction(parsedResult)}
                          disabled={!parsedResult.isValid || parsedResult.matchStatus === 'ambiguous'}
                          title={parsedResult.matchStatus === 'ambiguous' ? 'Hãy chọn sản phẩm trước' : undefined}
                          className={`flex-1 py-3 px-4 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition ${
                            parsedResult.isValid && parsedResult.matchStatus !== 'ambiguous'
                              ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/30 active:scale-98 cursor-pointer ring-2 ring-emerald-500/50'
                              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                          }`}
                        >
                          <Check className="w-4 h-4" />
                          <span>Nhấn để Lưu Giao Dịch</span>
                        </button>

                        <button
                          onClick={handleCancelResult}
                          className="py-3 px-4 rounded-xl font-medium text-sm bg-slate-800 hover:bg-slate-700 text-slate-300 transition cursor-pointer"
                        >
                          Hủy
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Quick Test Pills */}
                <div className="pt-2 text-left space-y-2">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400 font-semibold">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    <span>Thử nghiệm nhanh bằng câu lệnh mẫu (Bấm để test ngay):</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[
                      'nhập 10 gói mì omachi bò bằm',
                      'bán 5 gói mì hảo hảo chua cay',
                      'bán 2 lon bò húc',
                      'bán 5 chai nước aquafina',
                      'bán 3 gói mì hảo hảo',
                      'bán 2 lon bò cụng giá 15k',
                    ].map((sample) => (
                      <button
                        key={sample}
                        onClick={() => handleRunSampleCommand(sample)}
                        className="text-xs bg-slate-800/80 hover:bg-slate-700 hover:text-white border border-slate-700/80 text-slate-300 px-3 py-1.5 rounded-xl transition active:scale-95 cursor-pointer"
                      >
                        "{sample}"
                      </button>
                    ))}
                  </div>
                </div>

                {/* Manual Fallback Input */}
                <div className="pt-2 border-t border-slate-800/80 text-left">
                  <span className="text-xs text-slate-400 block mb-1.5">
                    Hoặc gõ câu lệnh tiếng Việt nếu không có micro:
                  </span>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (manualText.trim()) {
                        handleRunSampleCommand(manualText.trim());
                        setManualText('');
                      }
                    }}
                    className="flex gap-2"
                  >
                    <input
                      type="text"
                      value={manualText}
                      onChange={(e) => setManualText(e.target.value)}
                      placeholder='Ví dụ: "nhập 30 chai nước ngọt" hoặc "bán 5 gói bánh giá 12k"...'
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                    />
                    <button
                      type="submit"
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl border border-slate-700 transition"
                    >
                      Phân tích
                    </button>
                  </form>
                </div>
              </div>
            </div>

            {/* Quick mini-summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="bg-slate-900/60 border border-slate-800/80 p-4 rounded-2xl">
                <span className="text-xs text-slate-400">Tổng mặt hàng</span>
                <div className="text-xl sm:text-2xl font-black text-white mt-1">{stats.totalItems}</div>
              </div>
              <div className="bg-slate-900/60 border border-slate-800/80 p-4 rounded-2xl">
                <span className="text-xs text-slate-400">Tổng giao dịch</span>
                <div className="text-xl sm:text-2xl font-black text-emerald-400 mt-1">{stats.totalTransactions}</div>
              </div>
              <div className="bg-slate-900/60 border border-slate-800/80 p-4 rounded-2xl">
                <span className="text-xs text-slate-400">Sắp hết hàng (≤ 5)</span>
                <div className="text-xl sm:text-2xl font-black text-amber-400 mt-1">{stats.lowStockCount}</div>
              </div>
              <div className="bg-slate-900/60 border border-slate-800/80 p-4 rounded-2xl">
                <span className="text-xs text-slate-400">Hết hàng (≤ 0)</span>
                <div className="text-xl sm:text-2xl font-black text-rose-400 mt-1">{stats.outOfStockCount}</div>
              </div>
            </div>
          </div>
        )}

        {/* ================= TAB 2: BẢNG TỒN KHO ================= */}
        {activeTab === 'stock' && (
          <div className="bg-slate-900/70 border border-slate-800/80 rounded-2xl overflow-hidden shadow-xl backdrop-blur space-y-0">
            {/* Table Header toolbar */}
            <div className="p-4 sm:p-5 border-b border-slate-800 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <div>
                <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
                  <Package className="w-5 h-5 text-emerald-400" />
                  <span>Danh Mục Tồn Kho Hiện Tại</span>
                </h2>
                <p className="text-xs text-slate-400">
                  Tồn kho được tự động tính theo công thức: <code>Tồn kho = Tổng Nhập - Tổng Bán</code>
                </p>
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                <div className="relative flex-1 sm:w-64">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={stockSearch}
                    onChange={(e) => setStockSearch(e.target.value)}
                    placeholder="Tìm tên hàng hoặc đơn vị..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <button
                  onClick={() => {
                    setNewProdName('');
                    setNewProdUnit('cái');
                    setNewProdStock('0');
                    setNewProdSellPrice('');
                    setNewProdImportPrice('');
                    setAddProdError('');
                    setShowAddProductModal(true);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-sm cursor-pointer whitespace-nowrap"
                  title="Thêm sản phẩm mới vào kho"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>+ Thêm sản phẩm</span>
                </button>
              </div>
            </div>

            {/* Inventory Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-950/80 text-[11px] text-slate-400 uppercase tracking-wider border-b border-slate-800">
                  <tr>
                    <th className="p-3.5 sm:px-5">Tên Sản Phẩm</th>
                    <th className="p-3.5 sm:px-5">Đơn Vị</th>
                    <th className="p-3.5 sm:px-5 text-right">Giá Bán (VNĐ)</th>
                    <th className="p-3.5 sm:px-5 text-right">Giá Nhập (VNĐ)</th>
                    <th className="p-3.5 sm:px-5 text-right">Tổng Nhập</th>
                    <th className="p-3.5 sm:px-5 text-right">Tổng Bán</th>
                    <th className="p-3.5 sm:px-5 text-right">Tồn Kho Hiện Tại</th>
                    <th className="p-3.5 sm:px-5 text-right">Cập Nhật Cuối</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredInventory.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-8 text-center text-slate-500 text-sm">
                        Không tìm thấy mặt hàng nào phù hợp.
                      </td>
                    </tr>
                  ) : (
                    filteredInventory.map((item, index) => {
                      const isOut = item.currentStock <= 0;
                      const isLow = item.currentStock > 0 && item.currentStock <= 5;

                      return (
                        <tr key={index} className="hover:bg-slate-850/50 transition-colors">
                          <td className="p-3.5 sm:px-5 font-bold text-white flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-emerald-400" />
                            <span>{item.productName}</span>
                          </td>
                          <td className="p-3.5 sm:px-5 text-slate-400 font-medium">{item.unit}</td>
                          <td className="p-3.5 sm:px-5 text-right">
                            <PriceEditableCell
                              value={item.sellPrice}
                              onSave={(newVal) =>
                                handleUpdatePrice(item.productName, item.unit, 'sellPrice', newVal)
                              }
                            />
                          </td>
                          <td className="p-3.5 sm:px-5 text-right">
                            <PriceEditableCell
                              value={item.importPrice}
                              onSave={(newVal) =>
                                handleUpdatePrice(item.productName, item.unit, 'importPrice', newVal)
                              }
                            />
                          </td>
                          <td className="p-3.5 sm:px-5 text-right text-emerald-400 font-semibold">
                            +{item.totalImport}
                          </td>
                          <td className="p-3.5 sm:px-5 text-right text-amber-400 font-semibold">
                            -{item.totalExport}
                          </td>
                          <td className="p-3.5 sm:px-5 text-right">
                            <span
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-black ${
                                isOut
                                  ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                                  : isLow
                                  ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                                  : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                              }`}
                            >
                              {item.currentStock} {item.unit}
                              {isOut && <span className="text-[10px] font-normal">(Hết)</span>}
                              {isLow && <span className="text-[10px] font-normal">(Sắp hết)</span>}
                            </span>
                          </td>
                          <td className="p-3.5 sm:px-5 text-right text-xs text-slate-500 font-mono">
                            {formatDateTime(item.lastUpdated)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ================= TAB 3: LỊCH SỬ GIAO DỊCH ================= */}
        {activeTab === 'history' && (
          <div className="bg-slate-900/70 border border-slate-800/80 rounded-2xl overflow-hidden shadow-xl backdrop-blur space-y-0">
            {/* Toolbar */}
            <div className="p-4 sm:p-5 border-b border-slate-800 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <div>
                <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
                  <HistoryIcon className="w-5 h-5 text-emerald-400" />
                  <span>Nhật Ký Nhập / Bán Hàng Chi Tiết</span>
                </h2>
                <p className="text-xs text-slate-400">
                  Lưu lại từng câu lệnh giọng nói kèm thời gian chính xác
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                {/* Filter buttons */}
                <div className="inline-flex rounded-xl bg-slate-950 p-1 border border-slate-800 text-xs font-semibold">
                  <button
                    onClick={() => setHistoryTypeFilter('ALL')}
                    className={`px-3 py-1 rounded-lg transition ${
                      historyTypeFilter === 'ALL' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Tất cả
                  </button>
                  <button
                    onClick={() => setHistoryTypeFilter('NHAP')}
                    className={`px-3 py-1 rounded-lg transition ${
                      historyTypeFilter === 'NHAP' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Nhập ({history.filter((h) => h.type === 'NHAP').length})
                  </button>
                  <button
                    onClick={() => setHistoryTypeFilter('BAN')}
                    className={`px-3 py-1 rounded-lg transition ${
                      historyTypeFilter === 'BAN' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Bán ({history.filter((h) => h.type === 'BAN').length})
                  </button>
                </div>

                <button
                  onClick={handleExportHistoryCSV}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold border border-slate-700 flex items-center gap-1.5 transition"
                  title="Xuất file CSV"
                >
                  <Download className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Xuất CSV</span>
                </button>

                <button
                  onClick={() => {
                    if (window.confirm('Bạn có chắc muốn xóa sạch toàn bộ lịch sử giao dịch? (Dữ liệu tồn kho vẫn giữ nguyên)')) {
                      setHistory([]);
                      showToast('Đã xóa toàn bộ lịch sử giao dịch.', 'info');
                    }
                  }}
                  className="px-3 py-1.5 rounded-xl bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 text-xs font-semibold border border-rose-800/40 flex items-center gap-1.5 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Xóa toàn bộ</span>
                </button>
              </div>
            </div>

            {/* History Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-950/80 text-[11px] text-slate-400 uppercase tracking-wider border-b border-slate-800">
                  <tr>
                    <th className="p-3.5 sm:px-5">Thời Gian</th>
                    <th className="p-3.5 sm:px-5">Loại</th>
                    <th className="p-3.5 sm:px-5">Sản Phẩm</th>
                    <th className="p-3.5 sm:px-5 text-right">Số Lượng</th>
                    <th className="p-3.5 sm:px-5 text-right">Đơn Giá / Thành Tiền</th>
                    <th className="p-3.5 sm:px-5">Câu Thoại Gốc</th>
                    <th className="p-3.5 sm:px-5 text-center">Google Sheets</th>
                    <th className="p-3.5 sm:px-5 text-center">Thao Tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredHistory.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-8 text-center text-slate-500 text-sm">
                        Chưa có giao dịch nào được ghi nhận.
                      </td>
                    </tr>
                  ) : (
                    filteredHistory.map((tx) => {
                      const isNhap = tx.type === 'NHAP';
                      const isSheetsSent = tx.sheetsSyncStatus === 'sent_unconfirmed';

                      return (
                        <tr key={tx.id} className="hover:bg-slate-850/50 transition-colors">
                          <td className="p-3.5 sm:px-5 text-xs text-slate-400 font-mono">
                            {tx.formattedTime}
                          </td>
                          <td className="p-3.5 sm:px-5">
                            {isNhap ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-black uppercase px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                                <ArrowDownLeft className="w-3 h-3" /> Nhập
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[11px] font-black uppercase px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
                                <ArrowUpRight className="w-3 h-3" /> Bán
                              </span>
                            )}
                          </td>
                          <td className="p-3.5 sm:px-5 font-bold text-white">
                            {tx.productName}
                          </td>
                          <td className="p-3.5 sm:px-5 text-right font-black text-slate-200">
                            {tx.quantity} <span className="font-normal text-xs text-slate-400">{tx.unit}</span>
                          </td>
                          <td className="p-3.5 sm:px-5 text-right text-xs">
                            {tx.unitPrice ? (
                              <div>
                                <span className="text-slate-300 font-semibold">{formatVND(tx.unitPrice)}</span>
                                {tx.totalPrice && (
                                  <div className="text-[11px] text-amber-300 font-bold">
                                    Tổng: {formatVND(tx.totalPrice)}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-500">-</span>
                            )}
                          </td>
                          <td className="p-3.5 sm:px-5 text-xs text-slate-400 italic max-w-xs truncate" title={tx.rawTranscript}>
                            "{tx.rawTranscript}"
                          </td>

                          {/* Yêu cầu 5: Hiển thị trạng thái "Đã gửi (chưa xác nhận)" & nút "Gửi lại" */}
                          <td className="p-3.5 sm:px-5 text-center">
                            <div className="inline-flex items-center gap-1.5 text-xs">
                              {isSheetsSent ? (
                                <span
                                  className="px-2 py-0.5 rounded-md bg-sky-500/15 text-sky-300 border border-sky-500/30 text-[11px] font-medium"
                                  title="Đã gửi qua POST no-cors (chưa thể xác nhận phản hồi từ Sheets)"
                                >
                                  Đã gửi (chưa xác nhận)
                                </span>
                              ) : tx.sheetsSyncStatus === 'failed' ? (
                                <span
                                  className="px-2 py-0.5 rounded-md bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[11px] font-medium"
                                  title="Gửi tới Google Sheets thất bại"
                                >
                                  Thất bại
                                </span>
                              ) : (
                                <span className="text-slate-500 text-[11px]">Chưa gửi</span>
                              )}
                              <button
                                onClick={() => handleResendSheets(tx)}
                                className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-emerald-300 transition"
                                title="Gửi lại tới Google Sheets"
                              >
                                <RefreshCw className="w-3 h-3" />
                              </button>
                            </div>
                          </td>

                          {/* Thao tác: Hiện QR (nếu là đơn bán có giá và có cấu hình bank) + Xóa */}
                          <td className="p-3.5 sm:px-5 text-center">
                            <div className="flex items-center justify-center gap-1.5">
                              {tx.type === 'BAN' &&
                                (tx.totalPrice || 0) > 0 &&
                                Boolean(settings.bankId && settings.bankId.trim()) &&
                                Boolean(settings.bankAccountNo && settings.bankAccountNo.trim()) && (
                                  <button
                                    onClick={() => setQrTx(tx)}
                                    className="px-2 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 hover:text-emerald-200 text-xs font-semibold flex items-center gap-1 transition border border-emerald-500/30 cursor-pointer"
                                    title="Hiện mã QR chuyển khoản VietQR"
                                  >
                                    <QrCode className="w-3.5 h-3.5" />
                                    <span>Hiện QR</span>
                                  </button>
                                )}
                                {Boolean(settings.telegramBotToken && settings.telegramChatId) && (
                                  <button
                                    onClick={() => handleResendTelegram(tx)}
                                    className={`p-1.5 rounded-lg border transition cursor-pointer ${
                                      tx.syncedTelegram
                                        ? 'bg-sky-500/15 border-sky-500/30 text-sky-300 hover:bg-sky-500/25'
                                        : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-sky-300 hover:bg-slate-700'
                                    }`}
                                    title={tx.syncedTelegram ? 'Đã gửi Telegram (bấm để gửi lại)' : 'Gửi thông báo tới Telegram'}
                                  >
                                    <Bot className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              <button
                                onClick={() => deleteTransaction(tx.id, true)}
                                className="p-1.5 rounded-lg bg-rose-950/30 hover:bg-rose-900/60 text-rose-400 hover:text-rose-200 transition border border-rose-800/30 cursor-pointer"
                                title="Xóa giao dịch này và hoàn trả tồn kho"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ================= TAB 4: MÃ CODE.GS & HƯỚNG DẪN 3 BƯỚC ================= */}
        {activeTab === 'guide' && (
          <div className="space-y-6">
            {/* Guide Step-by-Step */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
              <div className="border-b border-slate-800 pb-4">
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <FileSpreadsheet className="w-5 h-5 text-emerald-400" />
                  <span>Hướng Dẫn 3 Bước Kết Nối Google Sheets & Telegram Bot</span>
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Chỉ cần thực hiện một lần duy nhất, toàn bộ dữ liệu giọng nói sẽ tự động cập nhật vào Google Sheets và báo cáo về Telegram tức thì.
                </p>
              </div>

              {/* Yêu cầu 6: Cảnh báo tránh gửi Telegram hai lần */}
              <div className="p-4 bg-amber-950/40 border border-amber-500/40 rounded-xl text-xs text-amber-200 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-bold text-amber-300 mb-0.5">Lưu ý quan trọng: Tránh gửi thông báo Telegram trùng lặp (2 lần)</h4>
                  <p className="text-amber-200/90 leading-relaxed">
                    Chỉ điền Telegram Bot Token & Chat ID ở <b>MỘT NƠI DUY NHẤT</b>:
                    <br />
                    • <b>Cách 1 (Khuyên dùng):</b> Điền Bot Token & Chat ID trong <b>Cài đặt của Web App</b> này. Khi đó, hãy để trống <code>TELEGRAM_CONFIG</code> trong Code.gs.
                    <br />
                    • <b>Cách 2:</b> Điền vào <code>TELEGRAM_CONFIG</code> trong Code.gs, thì <b>KHÔNG ĐƯỢC ĐIỀN</b> trong Cài đặt của Web App.
                    <br />
                    Tuyệt đối không điền ở cả 2 nơi để tránh bot gửi tin nhắn 2 lần cho mỗi giao dịch.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Step 1 */}
                <div className="bg-slate-950/70 border border-slate-800 p-5 rounded-2xl space-y-3">
                  <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 font-black flex items-center justify-center text-sm border border-emerald-500/40">
                    1
                  </div>
                  <h3 className="font-bold text-white text-sm">Tạo Google Sheet & Dán Code.gs</h3>
                  <ul className="text-xs text-slate-400 space-y-1.5 list-disc list-inside">
                    <li>Vào <a href="https://sheets.new" target="_blank" rel="noreferrer" className="text-emerald-400 underline font-semibold">sheets.new</a> tạo trang tính mới.</li>
                    <li>Chọn menu: <b>Tiện ích mở rộng (Extensions)</b> → <b>Apps Script</b>.</li>
                    <li>Xóa mã cũ, dán toàn bộ đoạn mã <code>Code.gs</code> ở khung bên dưới.</li>
                  </ul>
                </div>

                {/* Step 2 */}
                <div className="bg-slate-950/70 border border-slate-800 p-5 rounded-2xl space-y-3">
                  <div className="w-8 h-8 rounded-xl bg-teal-500/20 text-teal-400 font-black flex items-center justify-center text-sm border border-teal-500/40">
                    2
                  </div>
                  <h3 className="font-bold text-white text-sm">Triển Khai Web App Lấy Webhook</h3>
                  <ul className="text-xs text-slate-400 space-y-1.5 list-disc list-inside">
                    <li>Nhấn nút xanh <b>Triển khai (Deploy)</b> → <b>Tùy chọn triển khai mới (New deployment)</b>.</li>
                    <li>Loại: Chọn biểu tượng bánh răng ⚙️ → <b>Ứng dụng web (Web app)</b>.</li>
                    <li>Mục "Người có quyền truy cập": Chọn <b>Bất kỳ ai (Anyone)</b> (rất quan trọng!).</li>
                    <li>Bấm <b>Triển khai</b> và sao chép <b>URL ứng dụng web</b> (dán vào Cài đặt Web App).</li>
                  </ul>
                </div>

                {/* Step 3 */}
                <div className="bg-slate-950/70 border border-slate-800 p-5 rounded-2xl space-y-3">
                  <div className="w-8 h-8 rounded-xl bg-sky-500/20 text-sky-400 font-black flex items-center justify-center text-sm border border-sky-500/40">
                    3
                  </div>
                  <h3 className="font-bold text-white text-sm">Lấy Telegram Bot Token & Chat ID</h3>
                  <ul className="text-xs text-slate-400 space-y-1.5 list-disc list-inside">
                    <li>Mở Telegram tìm bot <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-sky-400 underline font-semibold">@BotFather</a> → gửi lệnh <code>/newbot</code> để lấy <b>Bot Token</b>.</li>
                    <li>Tìm bot <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" className="text-sky-400 underline font-semibold">@userinfobot</a> bấm Start để lấy số <b>Chat ID</b> cá nhân (hoặc thêm bot vào nhóm).</li>
                    <li>Mở Cài đặt trong Web App này, dán Token + Chat ID và bấm <b>Gửi thử</b>!</li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Code.gs Code View & Copy */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
              <div className="p-4 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-bold text-emerald-400">📄 Code.gs (Google Apps Script)</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">Tự tạo 3 sheet: LichSuGiaoDich, TonKho & HeThongDebug</span>
                </div>
                <button
                  onClick={handleCopyGasCode}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-md shadow-emerald-600/20"
                >
                  {copiedCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedCode ? 'Đã sao chép!' : 'Sao chép mã Code.gs'}</span>
                </button>
              </div>

              <div className="p-4 max-h-[460px] overflow-y-auto bg-slate-950 font-mono text-xs text-slate-300 leading-relaxed selection:bg-emerald-600">
                <pre>{GOOGLE_APPS_SCRIPT_CODE}</pre>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ================= SETTINGS MODAL ================= */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-xl w-full p-6 space-y-6 shadow-2xl max-h-[90vh] overflow-y-auto animate-in fade-in zoom-in-95">
            <div className="flex justify-between items-center border-b border-slate-800 pb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                  <SettingsIcon className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-base text-white">Cài Đặt Đồng Bộ & Phản Hồi</h3>
                  <p className="text-xs text-slate-400">Cấu hình Google Sheets, Telegram Bot và Trợ lý giọng nói</p>
                </div>
              </div>
              <button
                onClick={() => setShowSettingsModal(false)}
                className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center transition"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 text-sm">
              {/* Google Sheets Webhook URL */}
              <div className="space-y-1.5">
                <label className="flex items-center justify-between text-xs font-bold text-slate-300">
                  <span className="flex items-center gap-1.5">
                    <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
                    <span>URL Webhook Google Apps Script</span>
                  </span>
                  <button
                    onClick={() => {
                      setShowSettingsModal(false);
                      setActiveTab('guide');
                    }}
                    className="text-[11px] text-emerald-400 hover:underline"
                  >
                    Xem hướng dẫn lấy URL →
                  </button>
                </label>
                <input
                  type="text"
                  value={settings.googleSheetsWebhook}
                  onChange={(e) => setSettings({ ...settings, googleSheetsWebhook: e.target.value })}
                  placeholder="https://script.google.com/macros/s/.../exec"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                />
                <p className="text-[11px] text-slate-500">
                  Mỗi giao dịch sẽ được gửi thẳng tới Google Sheets để tự cập nhật 2 sheet <b>LichSuGiaoDich</b> và <b>TonKho</b>, kèm ghi log debug vào <b>HeThongDebug</b>.
                </p>

                <button
                  type="button"
                  onClick={handleTestGoogleSheets}
                  disabled={testSheetsStatus?.loading}
                  className="w-full mt-2 py-2 px-3 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-300 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  <Search className="w-3.5 h-3.5" />
                  <span>
                    {testSheetsStatus?.loading ? 'Đang kiểm tra kết nối...' : 'Kiểm tra kết nối Google Sheets (Tạo & ghi log HeThongDebug)'}
                  </span>
                </button>

                {testSheetsStatus && (
                  <p
                    className={`text-xs px-3 py-2 rounded-xl border mt-2 ${
                      testSheetsStatus.success
                        ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/40'
                        : 'bg-rose-950/40 text-rose-300 border-rose-800/40'
                    }`}
                  >
                    {testSheetsStatus.msg}
                  </p>
                )}
              </div>

              {/* Telegram Bot */}
              <div className="space-y-3 pt-2 border-t border-slate-800/80">
                <div className="flex items-center gap-1.5 text-xs font-bold text-slate-300">
                  <Bot className="w-3.5 h-3.5 text-sky-400" />
                  <span>Cấu hình Telegram Bot Thông Báo</span>
                </div>

                {/* Yêu cầu 6: Ghi chú tránh gửi 2 lần */}
                <div className="p-2.5 bg-amber-950/30 border border-amber-500/30 rounded-xl text-[11px] text-amber-300">
                  ⚠️ <b>Lưu ý:</b> Chỉ điền token ở <b>MỘT nơi</b> (trong cài đặt này HOẶC trong file Code.gs). Không điền cả hai nơi để tránh nhận 2 tin nhắn cho mỗi lần bán/nhập hàng.
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      Telegram Bot Token
                    </label>
                    <input
                      type="text"
                      value={settings.telegramBotToken}
                      onChange={(e) => setSettings({ ...settings, telegramBotToken: e.target.value })}
                      placeholder="123456789:AAH..."
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      Telegram Chat ID (Cá nhân / Nhóm)
                    </label>
                    <input
                      type="text"
                      value={settings.telegramChatId}
                      onChange={(e) => setSettings({ ...settings, telegramChatId: e.target.value })}
                      placeholder="-100... hoặc 987654321"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleTestTelegram}
                  disabled={testTgStatus?.loading}
                  className="w-full py-2 px-3 rounded-xl bg-sky-600/20 hover:bg-sky-600/30 border border-sky-500/30 text-sky-300 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Gửi thử tin nhắn Telegram kiểm tra</span>
                </button>

                {testTgStatus && (
                  <p
                    className={`text-xs px-3 py-2 rounded-xl border ${
                      testTgStatus.success
                        ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/40'
                        : 'bg-rose-950/40 text-rose-300 border-rose-800/40'
                    }`}
                  >
                    {testTgStatus.msg}
                  </p>
                )}
              </div>

              {/* Danh mục sản phẩm */}
              <div className="space-y-3 pt-2 border-t border-slate-800/80">
                <div className="flex items-center gap-1.5 text-xs font-bold text-slate-300">
                  <Package className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Danh mục sản phẩm</span>
                </div>
                <p className="text-[11px] text-slate-400">
                  {catalog.length > 0
                    ? `Đã có ${catalog.length} sản phẩm • cập nhật lần cuối: ${catalogUpdated || 'không rõ'}`
                    : 'Chưa có danh mục'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => loadCatalogFromSheets(false)}
                    disabled={catalogLoading}
                    className="px-3 py-2 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-300 text-xs font-bold transition cursor-pointer"
                  >
                    {catalogLoading ? 'Đang tải...' : 'Tải danh mục từ Sheet'}
                  </button>
                  <button
                    type="button"
                    onClick={() => csvInputRef.current && csvInputRef.current.click()}
                    className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-bold transition cursor-pointer"
                  >
                    Nhập danh mục từ file CSV
                  </button>
                  <input
                    ref={csvInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    hidden
                    onChange={handleCatalogCsv}
                  />
                </div>
              </div>

              {/* Tài khoản nhận tiền (QR chuyển khoản) (Yêu cầu 2) */}
              <div className="space-y-3 pt-2 border-t border-slate-800/80">
                <div className="flex items-center gap-1.5 text-xs font-bold text-slate-300">
                  <QrCode className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Tài khoản nhận tiền (QR chuyển khoản)</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      Ngân hàng (mã viết tắt, ví dụ MB, VCB, TCB, ACB)
                    </label>
                    <input
                      type="text"
                      value={settings.bankId || ''}
                      onChange={(e) => setSettings({ ...settings, bankId: e.target.value.trim().toUpperCase() })}
                      placeholder="MB, VCB, TCB, ACB..."
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 uppercase"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      Số tài khoản
                    </label>
                    <input
                      type="text"
                      value={settings.bankAccountNo || ''}
                      onChange={(e) => setSettings({ ...settings, bankAccountNo: e.target.value.trim() })}
                      placeholder="Ví dụ: 0123456789"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      Tên chủ tài khoản
                    </label>
                    <input
                      type="text"
                      value={settings.bankAccountName || ''}
                      onChange={(e) => setSettings({ ...settings, bankAccountName: e.target.value.toUpperCase() })}
                      placeholder="NGUYEN VAN A"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 uppercase"
                    />
                  </div>
                </div>
              </div>

              {/* Behavior Settings */}
              <div className="space-y-3 pt-2 border-t border-slate-800/80">
                <div className="text-xs font-bold text-slate-300">Tùy Chọn Phản Hồi & Xác Nhận Lưu</div>

                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800/80 flex items-center justify-between">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold text-white block">Cơ chế xác nhận lưu giao dịch</span>
                    <span className="text-[11px] text-slate-400 block">
                      Chỉ kích hoạt khi kết quả giọng nói đã chốt và đủ tồn kho. Nói xong bấm nút để lưu.
                    </span>
                  </div>
                  <span className="text-[11px] font-bold text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/30 whitespace-nowrap">
                    Bấm nút để lưu
                  </span>
                </div>

                <label className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800/80 cursor-pointer">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold text-white block">Đọc phản hồi bằng tiếng Việt (SpeechSynthesis)</span>
                    <span className="text-[11px] text-slate-500 block">Ví dụ: "Đã ghi nhận nhập 10 thùng mì tôm"</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.voiceFeedbackEnabled}
                    onChange={(e) => setSettings({ ...settings, voiceFeedbackEnabled: e.target.checked })}
                    className="w-4 h-4 accent-emerald-500 rounded"
                  />
                </label>

                <label className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800/80 cursor-pointer">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold text-white block">Âm thanh bíp & chuông xác nhận (Web Audio)</span>
                    <span className="text-[11px] text-slate-500 block">Âm bíp bắt đầu nghe và chuông thành công</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.beepSoundEnabled}
                    onChange={(e) => setSettings({ ...settings, beepSoundEnabled: e.target.checked })}
                    className="w-4 h-4 accent-emerald-500 rounded"
                  />
                </label>
              </div>
            </div>

            <div className="flex justify-between items-center pt-3 border-t border-slate-800">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className={`w-2 h-2 rounded-full ${syncStatus === 'synced' ? 'bg-emerald-400' : syncStatus === 'syncing' ? 'bg-amber-400' : 'bg-slate-500'}`} />
                <span>Đồng bộ ĐT & Máy tính: {syncStatus === 'synced' ? 'Đã kết nối' : syncStatus === 'syncing' ? 'Đang đồng bộ...' : 'Ngoại tuyến'}</span>
              </div>
              <button
                onClick={() => {
                  setShowSettingsModal(false);
                  pushServerSync({ settings }).then(() => {
                    showToast('Đã lưu cài đặt và đồng bộ lên đám mây!', 'success');
                  });
                }}
                className="px-5 py-2.5 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/25 transition cursor-pointer"
              >
                Hoàn tất & Lưu cài đặt
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= ADD PRODUCT MODAL ================= */}
      {showAddProductModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-md w-full p-6 space-y-5 shadow-2xl animate-in fade-in zoom-in-95">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                  <Package className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-base text-white">Thêm Sản Phẩm Mới</h3>
                  <p className="text-xs text-slate-400">Tạo danh mục mặt hàng mới trong kho</p>
                </div>
              </div>
              <button
                onClick={() => setShowAddProductModal(false)}
                className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center transition"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateProduct} className="space-y-3.5 text-xs">
              {addProdError && (
                <div className="p-2.5 rounded-xl bg-rose-950/50 border border-rose-800/60 text-rose-300 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{addProdError}</span>
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-300 mb-1">
                  Tên sản phẩm <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={newProdName}
                  onChange={(e) => setNewProdName(e.target.value)}
                  placeholder="Ví dụ: Mì tôm, Bò húc..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">
                    Đơn vị tính <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={newProdUnit}
                    onChange={(e) => setNewProdUnit(e.target.value)}
                    placeholder="thùng, lon, gói, cái..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-300 mb-1">
                    Tồn đầu kỳ (≥ 0)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={newProdStock}
                    onChange={(e) => setNewProdStock(e.target.value)}
                    placeholder="0"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">
                    Giá bán (VNĐ / đv)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={newProdSellPrice}
                    onChange={(e) => setNewProdSellPrice(e.target.value)}
                    placeholder="0"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-300 mb-1">
                    Giá nhập (VNĐ / đv)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={newProdImportPrice}
                    onChange={(e) => setNewProdImportPrice(e.target.value)}
                    placeholder="0"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <p className="text-[11px] text-slate-500 italic">
                * Tồn đầu kỳ sẽ được gán vào Tổng Nhập và Tồn kho hiện tại, không tạo bản ghi trong Lịch sử giao dịch.
              </p>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddProductModal(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white transition"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-md shadow-emerald-600/20 cursor-pointer"
                >
                  Lưu sản phẩm
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= MODAL MÃ QR THANH TOÁN (Yêu cầu 4) ================= */}
      {qrTx && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in fade-in zoom-in-95 text-center">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                  <QrCode className="w-4 h-4" />
                </div>
                <div className="text-left">
                  <h3 className="font-bold text-base text-white">Mã QR thanh toán</h3>
                  <p className="text-[11px] text-slate-400">VietQR chuyển khoản nhanh 24/7</p>
                </div>
              </div>
              <button
                onClick={() => setQrTx(null)}
                className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* QR Image Box */}
            <div className="bg-white p-3 rounded-2xl flex flex-col items-center justify-center min-h-[260px] shadow-inner">
              {qrImgError ? (
                <div className="p-4 text-xs text-rose-600 font-semibold flex flex-col items-center gap-2">
                  <AlertCircle className="w-8 h-8 text-rose-500" />
                  <span>Không tải được mã QR. Kiểm tra mã ngân hàng và số tài khoản trong Cài đặt.</span>
                </div>
              ) : (
                <img
                  src={buildVietQrUrl(
                    {
                      bankId: settings.bankId || '',
                      accountNo: settings.bankAccountNo || '',
                      accountName: settings.bankAccountName || '',
                    },
                    qrTx.totalPrice || 0,
                    qrTx.id
                  )}
                  alt="Mã QR thanh toán VietQR"
                  className="w-full max-w-[260px] h-auto object-contain rounded-lg"
                  onError={() => setQrImgError(true)}
                />
              )}
            </div>

            {/* Dưới ảnh hiện thông tin chi tiết */}
            <div className="space-y-2 text-xs text-slate-300 bg-slate-950/80 p-3.5 rounded-2xl border border-slate-800 text-left">
              <div className="font-bold text-white text-sm">
                {qrTx.productName} × {qrTx.quantity} {qrTx.unit}
              </div>
              <div className="flex justify-between items-center text-slate-300">
                <span>Số tiền:</span>
                <span className="font-extrabold text-amber-300 text-sm">
                  {formatVND(qrTx.totalPrice)}
                </span>
              </div>
              <div className="flex justify-between items-center text-slate-300">
                <span>Nội dung chuyển khoản:</span>
                <span className="font-mono font-bold text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/40">
                  {buildTransferNote(qrTx.id)}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 text-center pt-1 border-t border-slate-800/60">
                Khách quét mã bằng app ngân hàng
              </div>
            </div>

            <div className="pt-1">
              <button
                type="button"
                onClick={() => setQrTx(null)}
                className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold transition cursor-pointer"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= MODAL MỞ TRÊN ĐIỆN THOẠI (ĐỒNG BỘ ĐA THIẾT BỊ) ================= */}
      {showMobileConnectModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in fade-in zoom-in-95 text-center">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                  <Smartphone className="w-4 h-4" />
                </div>
                <h3 className="font-bold text-base text-white text-left">Đồng Bộ Điện Thoại & Máy Tính</h3>
              </div>
              <button
                onClick={() => setShowMobileConnectModal(false)}
                className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center transition"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-400">
              Mở camera điện thoại quét mã QR bên dưới để sử dụng cùng dữ liệu tồn kho và bán hàng:
            </p>

            {/* QR Code ảnh mở app trên điện thoại */}
            <div className="flex justify-center p-3 bg-white rounded-2xl w-fit mx-auto shadow-inner">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(typeof window !== 'undefined' ? window.location.href : '')}`}
                alt="QR Code kết nối điện thoại"
                className="w-48 h-48 object-contain"
              />
            </div>

            <div className="space-y-2 text-xs">
              <button
                type="button"
                onClick={() => {
                  if (typeof navigator !== 'undefined' && navigator.clipboard) {
                    navigator.clipboard.writeText(window.location.href);
                    setCopiedMobileLink(true);
                    setTimeout(() => setCopiedMobileLink(false), 2000);
                  }
                }}
                className="w-full py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center justify-center gap-1.5 transition font-semibold"
              >
                {copiedMobileLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-slate-400" />}
                <span>{copiedMobileLink ? 'Đã sao chép link app!' : 'Sao chép link mở app'}</span>
              </button>

              <div className="p-2.5 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-[11px] text-emerald-300 text-left space-y-1">
                <div className="font-bold flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Tự động đồng bộ 2 chiều:</span>
                </div>
                <p>
                  • Nhập/bán trên điện thoại → Máy tính cập nhật tức thì.
                </p>
                <p>
                  • Cập nhật giá, kho trên máy tính → Điện thoại nhận ngay lập tức.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowMobileConnectModal(false)}
              className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold transition cursor-pointer"
            >
              Đóng
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-950 text-slate-500 text-xs py-4 px-4 text-center mt-auto">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-2">
          <span>VoiceStock © 2026 - Quản lý Bán hàng & Tồn kho bằng Giọng nói thời gian thực.</span>
          <span className="text-slate-600">Pure Client-side • Web Speech API • Google Sheets • Telegram Bot</span>
        </div>
      </footer>
    </div>
  );
}
