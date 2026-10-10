/**
 * Trả về chuỗi toàn bộ mã nguồn single-file index.html thuần (Pure HTML + Tailwind CDN + Vanilla JS)
 * Chạy 100% trên trình duyệt không cần Node.js, không cần Python.
 */
export function generateStandaloneHtml(): string {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VoiceStock - Quản Lý Bán Hàng & Tồn Kho Bằng Giọng Nói</title>
  <!-- Tailwind CSS CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- Google Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; }
    .pulse-ring {
      animation: pulse-ring 2s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
    }
    @keyframes pulse-ring {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { transform: scale(1.05); box-shadow: 0 0 0 25px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }
    .recording-wave {
      animation: wave 1.2s ease-in-out infinite alternate;
    }
    @keyframes wave {
      0% { height: 8px; }
      100% { height: 36px; }
    }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen">
  <!-- Top Navigation -->
  <header class="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-40 px-4 py-3 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center font-bold text-slate-950 text-xl shadow-lg shadow-emerald-500/20">
        🎙️
      </div>
      <div>
        <h1 class="text-base sm:text-lg font-bold text-white tracking-tight flex items-center gap-2">
          VoiceStock <span class="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/30">Offline SPA</span>
        </h1>
        <p class="text-xs text-slate-400 hidden sm:block">Quản lý kho & bán hàng bằng giọng nói tiếng Việt</p>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <button onclick="openModal('settingsModal')" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium border border-slate-700 flex items-center gap-1.5 transition">
        ⚙️ Cài đặt
      </button>
    </div>
  </header>

  <main class="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
    <!-- Voice Controller Section -->
    <section class="bg-gradient-to-b from-slate-900 to-slate-900/80 border border-slate-800 rounded-3xl p-6 sm:p-8 text-center relative overflow-hidden shadow-2xl">
      <!-- Glow decoration -->
      <div class="absolute -top-24 left-1/2 -translate-x-1/2 w-96 h-96 bg-emerald-500/10 blur-3xl rounded-full pointer-events-none"></div>

      <div class="relative z-10 space-y-5">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider bg-slate-800 border border-slate-700" id="micStatusBadge">
          <span class="w-2 h-2 rounded-full bg-slate-500" id="micStatusDot"></span>
          <span id="micStatusText">Micro: Sẵn sàng</span>
        </div>

        <!-- Big Mic Button -->
        <div class="py-3 flex justify-center items-center">
          <button id="toggleMicBtn" onclick="toggleSpeech()" class="w-24 h-24 sm:w-28 sm:h-28 rounded-full bg-gradient-to-tr from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white flex flex-col items-center justify-center gap-1 shadow-xl shadow-emerald-500/30 transition-all active:scale-95 cursor-pointer">
            <span class="text-3xl sm:text-4xl" id="micIcon">🎙️</span>
            <span class="text-xs font-bold uppercase tracking-wider" id="micBtnLabel">Bấm Để Nói</span>
          </button>
        </div>

        <!-- Live transcript display -->
        <div class="bg-slate-950/70 border border-slate-800 rounded-2xl p-4 min-h-[72px] flex items-center justify-center text-center">
          <p id="transcriptText" class="text-base sm:text-lg text-slate-300 italic font-medium">
            Nhấn nút micro ở trên và nói: "Tôi nhập 10 thùng mì tôm" hoặc "Bán 2 chai nước tương giá 25k"...
          </p>
        </div>

        <!-- Parsed Result Card -->
        <div id="parsedResultCard" class="hidden bg-slate-800/90 border border-slate-700 rounded-2xl p-5 text-left space-y-4">
          <div class="flex items-center justify-between border-b border-slate-700 pb-3">
            <div class="flex items-center gap-2">
              <span id="badgeAction" class="px-3 py-1 rounded-full text-xs font-bold uppercase"></span>
              <span class="text-xs text-slate-400">Kết quả bóc tách</span>
            </div>
            <div id="autoSaveCountdown" class="text-xs font-semibold text-emerald-400 bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/30">
              Đã chốt giọng nói • Bấm nút để lưu
            </div>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-700/50">
              <div class="text-xs text-slate-400">Sản phẩm</div>
              <div id="resProduct" class="text-base font-bold text-white mt-0.5 truncate">-</div>
            </div>
            <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-700/50">
              <div class="text-xs text-slate-400">Số lượng & Đơn vị</div>
              <div id="resQuantity" class="text-base font-bold text-emerald-400 mt-0.5">-</div>
            </div>
            <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-700/50">
              <div class="text-xs text-slate-400">Đơn giá</div>
              <div id="resUnitPrice" class="text-base font-semibold text-slate-200 mt-0.5">-</div>
            </div>
            <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-700/50">
              <div class="text-xs text-slate-400">Thành tiền</div>
              <div id="resTotalPrice" class="text-base font-bold text-amber-300 mt-0.5">-</div>
            </div>
          </div>

          <!-- Actions -->
          <div class="flex flex-wrap gap-2 pt-2">
            <button onclick="confirmAndSave()" class="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 px-4 rounded-xl transition text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/30 ring-2 ring-emerald-500/50">
              ✅ Nhấn để Lưu Giao Dịch
            </button>
            <button onclick="cancelCurrentResult()" class="bg-slate-700 hover:bg-slate-600 text-slate-300 font-medium py-2.5 px-4 rounded-xl transition text-sm">
              Hủy
            </button>
          </div>
        </div>

        <!-- Quick Test Pills -->
        <div class="pt-2 text-left">
          <p class="text-xs text-slate-400 mb-2 font-medium">⚡ Thử nhanh câu lệnh mẫu:</p>
          <div class="flex flex-wrap gap-2">
            <button onclick="testCommand('tôi nhập 10 thùng mì tôm')" class="text-xs bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 px-3 py-1.5 rounded-lg transition">
              📦 "tôi nhập 10 thùng mì tôm"
            </button>
            <button onclick="testCommand('Tôi bán hàng 5 gói mì tôm')" class="text-xs bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 px-3 py-1.5 rounded-lg transition">
              🛍️ "Tôi bán hàng 5 gói mì tôm"
            </button>
            <button onclick="testCommand('nhập 50 lon bò húc')" class="text-xs bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 px-3 py-1.5 rounded-lg transition">
              ⚡ "nhập 50 lon bò húc"
            </button>
            <button onclick="testCommand('bán 2 chai nước tương chinsu giá 25k')" class="text-xs bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 px-3 py-1.5 rounded-lg transition">
              🥫 "bán 2 chai nước tương chinsu giá 25k"
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Navigation Tabs -->
    <div class="flex border-b border-slate-800 space-x-6 text-sm font-semibold">
      <button onclick="switchTab('stockTab')" id="tabBtnStock" class="pb-3 border-b-2 border-emerald-500 text-emerald-400 flex items-center gap-2">
        📊 Bảng Quản Lý Tồn Kho
      </button>
      <button onclick="switchTab('historyTab')" id="tabBtnHistory" class="pb-3 border-b-2 border-transparent text-slate-400 hover:text-slate-200 flex items-center gap-2">
        📜 Lịch Sử Giao Dịch
      </button>
    </div>

    <!-- Inventory Tab Content -->
    <section id="stockTab" class="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
      <div class="p-4 border-b border-slate-800 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <h2 class="font-bold text-white text-base">Danh mục hàng hóa trong kho</h2>
        <input type="text" id="stockSearchInput" oninput="renderStockTable()" placeholder="🔍 Tìm kiếm sản phẩm..." class="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500 w-full sm:w-64">
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="bg-slate-950/60 text-xs text-slate-400 uppercase border-b border-slate-800">
            <tr>
              <th class="p-3">Sản phẩm</th>
              <th class="p-3">Đơn vị</th>
              <th class="p-3 text-right">Tổng Nhập</th>
              <th class="p-3 text-right">Tổng Bán</th>
              <th class="p-3 text-right">Tồn Kho Hiện Tại</th>
              <th class="p-3 text-right">Cập nhật cuối</th>
            </tr>
          </thead>
          <tbody id="stockTableBody" class="divide-y divide-slate-800/60">
            <!-- Rendered by JS -->
          </tbody>
        </table>
      </div>
    </section>

    <!-- History Tab Content -->
    <section id="historyTab" class="hidden bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
      <div class="p-4 border-b border-slate-800 flex justify-between items-center">
        <h2 class="font-bold text-white text-base">Nhật ký nhập xuất chi tiết</h2>
        <button onclick="clearHistory()" class="text-xs text-rose-400 hover:text-rose-300 font-semibold px-2 py-1 rounded border border-rose-500/20">
          Xóa lịch sử
        </button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="bg-slate-950/60 text-xs text-slate-400 uppercase border-b border-slate-800">
            <tr>
              <th class="p-3">Thời gian</th>
              <th class="p-3">Loại</th>
              <th class="p-3">Sản phẩm</th>
              <th class="p-3 text-right">Số lượng</th>
              <th class="p-3 text-right">Đơn giá / Tổng</th>
              <th class="p-3">Câu thoại gốc</th>
            </tr>
          </thead>
          <tbody id="historyTableBody" class="divide-y divide-slate-800/60">
            <!-- Rendered by JS -->
          </tbody>
        </table>
      </div>
    </section>
  </main>

  <!-- Settings Modal -->
  <div id="settingsModal" class="hidden fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
    <div class="bg-slate-900 border border-slate-800 rounded-3xl max-w-lg w-full p-6 space-y-5 max-h-[90vh] overflow-y-auto">
      <div class="flex justify-between items-center border-b border-slate-800 pb-3">
        <h3 class="font-bold text-lg text-white">⚙️ Cài Đặt Hệ Thống</h3>
        <button onclick="closeModal('settingsModal')" class="text-slate-400 hover:text-white text-xl">✕</button>
      </div>

      <div class="space-y-4 text-sm">
        <div>
          <label class="block text-xs font-semibold text-slate-300 mb-1">URL Webhook Google Apps Script</label>
          <input type="text" id="cfgGoogleSheet" placeholder="https://script.google.com/macros/s/.../exec" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500">
          <p class="text-[11px] text-slate-500 mt-1">Webhook tự động đồng bộ vào 3 sheet: LichSuGiaoDich, TonKho & HeThongDebug.</p>
          <button onclick="testGoogleSheetsWebhook()" class="w-full mt-2 py-2 bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 border border-emerald-500/30 rounded-xl text-xs font-semibold transition">
            🔍 Kiểm tra kết nối Google Sheets (Tạo & ghi log HeThongDebug)
          </button>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">Telegram Bot Token</label>
            <input type="text" id="cfgTelegramToken" placeholder="123456789:AAH..." class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500">
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">Telegram Chat ID</label>
            <input type="text" id="cfgTelegramChatId" placeholder="-100... hoặc 987654321" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500">
          </div>
        </div>

        <p class="text-[11px] text-amber-400 bg-amber-500/10 p-2 rounded-lg border border-amber-500/20">
          ⚠️ Lưu ý: Chỉ điền Telegram Bot Token ở MỘT nơi (trong app HOẶC trong Code.gs), không điền cả hai nơi để tránh nhận tin nhắn trùng lặp.
        </p>

        <button onclick="testTelegramMsg()" class="w-full py-2 bg-sky-600/30 hover:bg-sky-600/50 text-sky-300 border border-sky-500/30 rounded-xl text-xs font-semibold transition">
          ✈️ Gửi thử tin nhắn Telegram kiểm tra
        </button>

        <div class="pt-2 border-t border-slate-800 space-y-3">
          <div class="p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-400 flex items-center justify-between">
            <span>Cơ chế xác nhận: Chỉ kích hoạt khi chốt giọng nói & đủ tồn kho</span>
            <span class="text-[11px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">Bấm nút để lưu</span>
          </div>
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" id="cfgVoiceFeedback" checked class="rounded bg-slate-950 border-slate-800 text-emerald-500 focus:ring-0">
            <span class="text-xs text-slate-300">Đọc phản hồi âm thanh bằng tiếng Việt (SpeechSynthesis)</span>
          </label>
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-3 border-t border-slate-800">
        <button onclick="closeModal('settingsModal')" class="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white">Hủy</button>
        <button onclick="saveSettings()" class="px-5 py-2 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white">Lưu cài đặt</button>
      </div>
    </div>
  </div>

  <script>
    // Escape HTML để bảo vệ chống XSS khi chèn vào innerHTML
    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // NLP & Data Logic
    const UNITS = ['thùng', 'gói', 'hộp', 'chai', 'lon', 'cái', 'kg', 'kí', 'ký', 'gam', 'chiếc', 'lốc', 'vỉ', 'túi', 'bao', 'bịch', 'cuộn', 'bó', 'ly', 'cốc', 'bình', 'lít'];
    const NUMBERS = { 'nửa': 0.5, 'một': 1, 'hai': 2, 'ba': 3, 'bốn': 4, 'tư': 4, 'năm': 5, 'lăm': 5, 'sáu': 6, 'bảy': 7, 'tám': 8, 'chín': 9, 'mười': 10, 'hai mươi': 20, 'ba mươi': 30, 'năm mươi': 50, 'một trăm': 100 };
    const FILLERS = ['cho tôi', 'tôi', 'em', 'anh', 'chị', 'giùm', 'hộ', 'nhé', 'ạ', 'nha', 'vào kho', 'trong kho', 'với'];

    let inventory = JSON.parse(localStorage.getItem('voicestock_inventory') || '[]');
    let history = JSON.parse(localStorage.getItem('voicestock_history') || '[]');
    let settings = JSON.parse(localStorage.getItem('voicestock_settings') || '{}');

    // Default inventory sample if empty
    if (inventory.length === 0) {
      inventory = [
        { productName: 'Mì tôm', unit: 'thùng', totalImport: 50, totalExport: 15, currentStock: 35, lastUpdated: new Date().toLocaleString('vi-VN') },
        { productName: 'Bò húc', unit: 'lon', totalImport: 120, totalExport: 40, currentStock: 80, lastUpdated: new Date().toLocaleString('vi-VN') },
        { productName: 'Nước tương chinsu', unit: 'chai', totalImport: 30, totalExport: 8, currentStock: 22, lastUpdated: new Date().toLocaleString('vi-VN') }
      ];
      localStorage.setItem('voicestock_inventory', JSON.stringify(inventory));
    }

    let recognition = null;
    let isRecording = false;
    let currentResult = null;
    let autoSaveTimer = null;
    let countdownSec = 3;

    function initSpeech() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        document.getElementById('micStatusText').textContent = 'Trình duyệt không hỗ trợ Web Speech API';
        return;
      }
      recognition = new SpeechRecognition();
      recognition.lang = 'vi-VN';
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onstart = () => {
        isRecording = true;
        updateMicUI(true);
      };

      recognition.onresult = (event) => {
        let interim = '';
        let final = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            final += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        const text = final || interim;
        document.getElementById('transcriptText').textContent = '"' + text + '"';
        if (text) {
          processTranscript(text, Boolean(final));
        }
      };

      recognition.onerror = (e) => {
        console.warn('Speech error:', e);
        if (e.error !== 'no-speech') {
          updateMicUI(false);
        }
      };

      recognition.onend = () => {
        if (isRecording) {
          try { recognition.start(); } catch(err){}
        } else {
          updateMicUI(false);
        }
      };
    }

    function toggleSpeech() {
      if (!recognition) initSpeech();
      if (!recognition) return alert('Vui lòng sử dụng Google Chrome trên máy tính hoặc điện thoại Android để có Web Speech API tốt nhất.');
      
      if (isRecording) {
        isRecording = false;
        recognition.stop();
        updateMicUI(false);
      } else {
        try {
          recognition.start();
        } catch(e) {
          console.error(e);
        }
      }
    }

    function updateMicUI(listening) {
      const btn = document.getElementById('toggleMicBtn');
      const dot = document.getElementById('micStatusDot');
      const text = document.getElementById('micStatusText');
      const label = document.getElementById('micBtnLabel');

      if (listening) {
        btn.classList.add('pulse-ring');
        dot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
        text.textContent = 'Đang lắng nghe...';
        label.textContent = 'Đang Nghe';
      } else {
        btn.classList.remove('pulse-ring');
        dot.className = 'w-2 h-2 rounded-full bg-slate-500';
        text.textContent = 'Micro: Sẵn sàng';
        label.textContent = 'Bấm Để Nói';
      }
    }

    function parseNLP(raw) {
      const lower = raw.toLowerCase();
      let action = null;
      if (/(nhập hàng|nhập kho|mua vào|về hàng|nhập)/i.test(lower)) action = 'NHAP';
      else if (/(bán hàng|khách mua|khách lấy|xuất|bán)/i.test(lower)) action = 'BAN';

      // Price
      let unitPrice = null;
      let priceMatch = lower.match(/(?:giá\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(?:k|nghìn|ngàn)/i);
      if (priceMatch) unitPrice = Math.round(parseFloat(priceMatch[1].replace(',', '.')) * 1000);
      else {
        let fullPrice = lower.match(/giá\\s*[:=]?\\s*(\\d{1,3}(?:[.,]\\d{3})*|\\d+)/i);
        if (fullPrice) unitPrice = parseInt(fullPrice[1].replace(/[.,]/g, ''), 10);
      }

      // Quantity
      let quantity = null;
      let qMatch = lower.match(/\\b(\\d+(?:[.,]\\d+)?)\\b/);
      if (qMatch) quantity = parseFloat(qMatch[1].replace(',', '.'));
      else {
        for (const [w, num] of Object.entries(NUMBERS)) {
          if (new RegExp('\\\\b' + w + '\\\\b').test(lower)) {
            quantity = num;
            break;
          }
        }
      }

      // Unit
      let unit = 'cái';
      for (const u of UNITS) {
        if (new RegExp('\\\\b' + u + '\\\\b').test(lower)) {
          unit = u;
          break;
        }
      }

      // Clean product
      let prod = raw;
      FILLERS.forEach(f => { prod = prod.replace(new RegExp('\\\\b' + f + '\\\\b', 'gi'), ''); });
      prod = prod.replace(/(nhập hàng|nhập kho|nhập|mua vào|về hàng|bán hàng|bán|xuất|khách mua|khách lấy|giá|tiền)/gi, '');
      if (unitPrice) prod = prod.replace(new RegExp('\\\\b\\\\d+(?:[.,]\\\\d+)?\\\\s*(?:k|nghìn|ngàn|đ)?\\\\b', 'gi'), '');
      if (quantity) prod = prod.replace(new RegExp('\\\\b' + quantity + '\\\\b', 'gi'), '');
      prod = prod.replace(new RegExp('\\\\b' + unit + '\\\\b', 'gi'), '');
      prod = prod.replace(/[^\\p{L}\\s\\d]/gu, '').replace(/\\s+/g, ' ').trim();
      if (prod) prod = prod.charAt(0).toUpperCase() + prod.slice(1);

      return {
        action,
        quantity,
        unit,
        productName: prod,
        unitPrice,
        totalPrice: unitPrice && quantity ? unitPrice * quantity : null,
        raw
      };
    }

    function processTranscript(text, isFinal) {
      // Chỉ kích hoạt kết quả bóc tách khi kết quả giọng nói đã chốt (isFinal = true)
      if (!isFinal) return;

      const parsed = parseNLP(text);
      if (parsed.action && parsed.quantity && parsed.productName) {
        currentResult = parsed;
        showParsedCard(parsed, true);
      }
    }

    function showParsedCard(res, _isFinal) {
      const card = document.getElementById('parsedResultCard');
      const badge = document.getElementById('badgeAction');
      card.classList.remove('hidden');

      if (res.action === 'NHAP') {
        badge.className = 'px-3 py-1 rounded-full text-xs font-bold uppercase bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
        badge.textContent = 'NHẬP HÀNG';
      } else {
        badge.className = 'px-3 py-1 rounded-full text-xs font-bold uppercase bg-amber-500/20 text-amber-400 border border-amber-500/30';
        badge.textContent = 'BÁN HÀNG';
      }

      document.getElementById('resProduct').textContent = res.productName;
      document.getElementById('resQuantity').textContent = res.quantity + ' ' + res.unit;
      document.getElementById('resUnitPrice').textContent = res.unitPrice ? res.unitPrice.toLocaleString('vi-VN') + ' đ' : '-';
      document.getElementById('resTotalPrice').textContent = res.totalPrice ? res.totalPrice.toLocaleString('vi-VN') + ' đ' : '-';

      // Kiểm tra bán quá tồn kho
      let item = inventory.find(i => i.productName.toLowerCase() === res.productName.toLowerCase() && i.unit.toLowerCase() === res.unit.toLowerCase());
      let curStock = item ? item.currentStock : 0;
      let overselling = (res.action === 'BAN' && curStock - res.quantity < 0);

      const statusEl = document.getElementById('autoSaveCountdown');
      if (overselling) {
        statusEl.className = 'text-xs font-semibold text-amber-400 bg-amber-500/10 px-3 py-1 rounded-full border border-amber-500/30';
        statusEl.textContent = '⚠️ Cảnh báo: Tồn kho chỉ còn ' + curStock + ' ' + res.unit + ' (Bán quá tồn)';
      } else {
        statusEl.className = 'text-xs font-semibold text-emerald-400 bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/30';
        statusEl.textContent = '✅ Đã chốt giọng nói • Nhấn nút để lưu';
      }
    }

    function confirmAndSave() {
      clearInterval(autoSaveTimer);
      if (!currentResult) return;
      const res = currentResult;

      const now = new Date();
      const timeStr = now.toLocaleTimeString('vi-VN') + ' ' + now.toLocaleDateString('vi-VN');

      const tx = {
        id: 'TX' + Math.random().toString(36).substring(2, 8).toUpperCase(),
        formattedTime: timeStr,
        type: res.action,
        productName: res.productName,
        quantity: res.quantity,
        unit: res.unit,
        unitPrice: res.unitPrice,
        totalPrice: res.totalPrice,
        rawTranscript: res.raw
      };

      // 1. Update History
      history.unshift(tx);
      localStorage.setItem('voicestock_history', JSON.stringify(history));

      // 2. Update Inventory
      let item = inventory.find(i => i.productName.toLowerCase() === res.productName.toLowerCase() && i.unit.toLowerCase() === res.unit.toLowerCase());
      if (!item) {
        item = {
          productName: res.productName,
          unit: res.unit,
          totalImport: res.action === 'NHAP' ? res.quantity : 0,
          totalExport: res.action === 'BAN' ? res.quantity : 0,
          currentStock: res.action === 'NHAP' ? res.quantity : -res.quantity,
          lastUpdated: timeStr
        };
        inventory.push(item);
      } else {
        if (res.action === 'NHAP') item.totalImport += res.quantity;
        else item.totalExport += res.quantity;
        item.currentStock = item.totalImport - item.totalExport;
        item.lastUpdated = timeStr;
      }
      localStorage.setItem('voicestock_inventory', JSON.stringify(inventory));

      // 3. Speech synthesis feedback
      const feedbackText = res.action === 'NHAP'
        ? ('Đã ghi nhận nhập ' + res.quantity + ' ' + res.unit + ' ' + res.productName)
        : ('Đã ghi nhận bán ' + res.quantity + ' ' + res.unit + ' ' + res.productName);
      
      if (document.getElementById('cfgVoiceFeedback')?.checked !== false) {
        speak(feedbackText);
      }

      // 4. Send to Google Sheets (if configured)
      const sheetUrl = (document.getElementById('cfgGoogleSheet')?.value || settings.googleSheetsWebhook || '').trim();
      if (sheetUrl) {
        fetch(sheetUrl, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction: tx, inventory: item })
        }).catch(err => console.warn('Lỗi sync Sheets:', err));
      }

      // 5. Send to Telegram (if configured)
      const tToken = (document.getElementById('cfgTelegramToken')?.value || settings.telegramBotToken || '').trim();
      const tChat = (document.getElementById('cfgTelegramChatId')?.value || settings.telegramChatId || '').trim();
      if (tToken && tChat) {
        const tgText = (res.action === 'NHAP' ? '🟢 <b>[NHẬP KHO THÀNH CÔNG]</b>' : '🔴 <b>[BÁN HÀNG THÀNH CÔNG]</b>') +
          '\\n\\n📦 <b>Sản phẩm:</b> ' + escapeHtml(tx.productName) + '\\n🔢 <b>Số lượng:</b> ' + tx.quantity + ' ' + escapeHtml(tx.unit) +
          (tx.unitPrice ? ('\\n💵 <b>Đơn giá:</b> ' + tx.unitPrice.toLocaleString('vi-VN') + ' đ') : '') +
          '\\n📊 <b>Tồn kho hiện tại:</b> <code>' + item.currentStock + ' ' + escapeHtml(item.unit) + '</code>' +
          '\\n⏰ <b>Thời gian:</b> ' + escapeHtml(tx.formattedTime) + '\\n🗣️ <b>Lệnh thoại:</b> <i>"' + escapeHtml(tx.rawTranscript) + '"</i>';

        fetch('https://api.telegram.org/bot' + tToken + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: tChat, text: tgText, parse_mode: 'HTML' })
        }).catch(e => console.warn('Telegram error:', e));
      }

      renderStockTable();
      renderHistoryTable();
      cancelCurrentResult();
    }

    function cancelCurrentResult() {
      clearInterval(autoSaveTimer);
      currentResult = null;
      document.getElementById('parsedResultCard').classList.add('hidden');
    }

    function speak(text) {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'vi-VN';
      window.speechSynthesis.speak(u);
    }

    function testCommand(text) {
      document.getElementById('transcriptText').textContent = '"' + text + '"';
      processTranscript(text, true);
    }

    function renderStockTable() {
      const q = (document.getElementById('stockSearchInput')?.value || '').toLowerCase();
      const body = document.getElementById('stockTableBody');
      const filtered = inventory.filter(i => i.productName.toLowerCase().includes(q) || i.unit.toLowerCase().includes(q));

      if (filtered.length === 0) {
        body.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-slate-500">Chưa có sản phẩm nào</td></tr>';
        return;
      }

      body.innerHTML = filtered.map(i => {
        const badgeColor = i.currentStock <= 0 ? 'text-rose-400 bg-rose-500/10' : (i.currentStock <= 5 ? 'text-amber-400 bg-amber-500/10' : 'text-emerald-400 bg-emerald-500/10');
        const safeName = escapeHtml(i.productName);
        const safeUnit = escapeHtml(i.unit);
        const safeUpdated = escapeHtml(i.lastUpdated);
        return '<tr class="hover:bg-slate-800/40">' +
          '<td class="p-3 font-semibold text-white">' + safeName + '</td>' +
          '<td class="p-3 text-slate-400">' + safeUnit + '</td>' +
          '<td class="p-3 text-right text-slate-300">' + i.totalImport + '</td>' +
          '<td class="p-3 text-right text-slate-300">' + i.totalExport + '</td>' +
          '<td class="p-3 text-right font-bold ' + badgeColor + '">' + i.currentStock + ' ' + safeUnit + '</td>' +
          '<td class="p-3 text-right text-xs text-slate-500">' + safeUpdated + '</td>' +
        '</tr>';
      }).join('');
    }

    function renderHistoryTable() {
      const body = document.getElementById('historyTableBody');
      if (history.length === 0) {
        body.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-slate-500">Chưa có giao dịch nào</td></tr>';
        return;
      }

      body.innerHTML = history.slice(0, 50).map(t => {
        const isNhap = t.type === 'NHAP';
        const typeBadge = isNhap
          ? '<span class="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">NHẬP</span>'
          : '<span class="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">BÁN</span>';
        const priceStr = t.unitPrice ? (t.unitPrice.toLocaleString('vi-VN') + ' đ' + (t.totalPrice ? ' (Tổng: ' + t.totalPrice.toLocaleString('vi-VN') + ' đ)' : '')) : '-';
        const safeTime = escapeHtml(t.formattedTime);
        const safeName = escapeHtml(t.productName);
        const safeUnit = escapeHtml(t.unit);
        const safeTranscript = escapeHtml(t.rawTranscript);

        return '<tr class="hover:bg-slate-800/40">' +
          '<td class="p-3 text-xs text-slate-400">' + safeTime + '</td>' +
          '<td class="p-3">' + typeBadge + '</td>' +
          '<td class="p-3 font-semibold text-white">' + safeName + '</td>' +
          '<td class="p-3 text-right font-bold text-slate-200">' + t.quantity + ' ' + safeUnit + '</td>' +
          '<td class="p-3 text-right text-xs text-amber-300">' + priceStr + '</td>' +
          '<td class="p-3 text-xs text-slate-400 italic max-w-xs truncate">"' + safeTranscript + '"</td>' +
        '</tr>';
      }).join('');
    }

    function clearHistory() {
      if (confirm('Bạn có chắc muốn xóa lịch sử giao dịch? (Tồn kho vẫn được giữ nguyên)')) {
        history = [];
        localStorage.setItem('voicestock_history', '[]');
        renderHistoryTable();
      }
    }

    function switchTab(tabId) {
      document.getElementById('stockTab').classList.toggle('hidden', tabId !== 'stockTab');
      document.getElementById('historyTab').classList.toggle('hidden', tabId !== 'historyTab');

      const btnS = document.getElementById('tabBtnStock');
      const btnH = document.getElementById('tabBtnHistory');
      if (tabId === 'stockTab') {
        btnS.className = 'pb-3 border-b-2 border-emerald-500 text-emerald-400 flex items-center gap-2';
        btnH.className = 'pb-3 border-b-2 border-transparent text-slate-400 hover:text-slate-200 flex items-center gap-2';
      } else {
        btnH.className = 'pb-3 border-b-2 border-emerald-500 text-emerald-400 flex items-center gap-2';
        btnS.className = 'pb-3 border-b-2 border-transparent text-slate-400 hover:text-slate-200 flex items-center gap-2';
      }
    }

    function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
    function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

    function saveSettings() {
      settings.googleSheetsWebhook = document.getElementById('cfgGoogleSheet').value;
      settings.telegramBotToken = document.getElementById('cfgTelegramToken').value;
      settings.telegramChatId = document.getElementById('cfgTelegramChatId').value;
      localStorage.setItem('voicestock_settings', JSON.stringify(settings));
      closeModal('settingsModal');
      alert('Đã lưu cấu hình thành công!');
    }

    function testGoogleSheetsWebhook() {
      const url = (document.getElementById('cfgGoogleSheet')?.value || settings.googleSheetsWebhook || '').trim();
      if (!url) return alert('Vui lòng nhập URL Webhook Google Apps Script trước khi kiểm tra.');

      const startTime = Date.now();
      fetch(url, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'TEST_CONNECTION',
          clientTime: new Date().toISOString(),
          note: 'Kiểm tra kết nối và tạo sheet HeThongDebug từ Web App VoiceStock (Offline HTML)'
        })
      })
      .then(() => {
        const dur = Date.now() - startTime;
        alert('✅ Kết nối thành công (' + dur + 'ms)! Đã gửi tín hiệu kiểm tra và ghi nhật ký vào sheet "HeThongDebug".');
      })
      .catch(err => {
        alert('❌ Lỗi kết nối Google Sheets: ' + err.message);
      });
    }

    function testTelegramMsg() {
      const token = document.getElementById('cfgTelegramToken').value.trim();
      const chat = document.getElementById('cfgTelegramChatId').value.trim();
      if (!token || !chat) return alert('Vui lòng nhập cả Token và Chat ID trước.');

      fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: '🎉 <b>VoiceStock:</b> Kết nối Telegram Bot thành công!', parse_mode: 'HTML' })
      })
      .then(res => res.json())
      .then(data => {
        if (data.ok) alert('✅ Gửi thử thành công! Kiểm tra tin nhắn Telegram của bạn.');
        else alert('❌ Lỗi Telegram: ' + (data.description || 'Không xác định'));
      })
      .catch(e => alert('❌ Lỗi kết nối: ' + e.message));
    }

    // Init
    window.addEventListener('DOMContentLoaded', () => {
      document.getElementById('cfgGoogleSheet').value = settings.googleSheetsWebhook || '';
      document.getElementById('cfgTelegramToken').value = settings.telegramBotToken || '';
      document.getElementById('cfgTelegramChatId').value = settings.telegramChatId || '';
      renderStockTable();
      renderHistoryTable();
      initSpeech();
    });
  </script>
</body>
</html>`;
}
