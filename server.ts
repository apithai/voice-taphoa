import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const DATA_DIR = path.resolve(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

// Đảm bảo thư mục lưu trữ dữ liệu tồn tại
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

interface ServerStore {
  inventory: any[];
  history: any[];
  settings: any;
  catalog: any[];
  catalogUpdated: string;
  updatedAt: number;
}

const DEFAULT_STORE: ServerStore = {
  inventory: [],
  history: [],
  settings: null,
  catalog: [],
  catalogUpdated: '',
  updatedAt: 0,
};

function readStore(): ServerStore {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const content = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      return {
        inventory: Array.isArray(parsed.inventory) ? parsed.inventory : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
        settings: parsed.settings || null,
        catalog: Array.isArray(parsed.catalog) ? parsed.catalog : [],
        catalogUpdated: parsed.catalogUpdated || '',
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      };
    }
  } catch (err) {
    console.error('Lỗi đọc store.json:', err);
  }
  return { ...DEFAULT_STORE, updatedAt: Date.now() };
}

let storeCache: ServerStore = readStore();

function writeStore(newStore: Partial<ServerStore>) {
  storeCache = {
    ...storeCache,
    ...newStore,
    updatedAt: Date.now(),
  };
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(storeCache, null, 2), 'utf-8');
  } catch (err) {
    console.error('Lỗi ghi store.json:', err);
  }
}

async function startServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // API ĐỒNG BỘ DỮ LIỆU ĐA THIẾT BỊ (MÁY TÍNH & ĐIỆN THOẠI)
  app.get('/api/sync', (_req, res) => {
    res.json({
      success: true,
      data: storeCache,
      serverTime: new Date().toISOString(),
    });
  });

  app.post('/api/sync', (req, res) => {
    try {
      const { inventory, history, settings, catalog, catalogUpdated } = req.body || {};
      const updates: Partial<ServerStore> = {};

      if (Array.isArray(inventory)) {
        updates.inventory = inventory;
      }

      if (Array.isArray(history)) {
        // Hợp nhất lịch sử theo ID để không bị mất giao dịch giữa 2 máy
        const map = new Map<string, any>();
        // Ưu tiên lịch sử gửi lên
        for (const tx of history) {
          if (tx && tx.id) map.set(tx.id, tx);
        }
        // Giữ lại các giao dịch cũ trên server nếu client chưa có
        for (const tx of storeCache.history) {
          if (tx && tx.id && !map.has(tx.id)) {
            map.set(tx.id, tx);
          }
        }
        const mergedHistory = Array.from(map.values()).sort((a, b) => {
          const tA = new Date(a.timestamp || 0).getTime();
          const tB = new Date(b.timestamp || 0).getTime();
          return tB - tA;
        });
        updates.history = mergedHistory;
      }

      if (settings && typeof settings === 'object') {
        // Hợp nhất cài đặt: giữ nguyên các trường có giá trị
        updates.settings = {
          ...(storeCache.settings || {}),
          ...settings,
        };
      }

      if (Array.isArray(catalog) && catalog.length > 0) {
        updates.catalog = catalog;
        if (catalogUpdated) {
          updates.catalogUpdated = catalogUpdated;
        }
      }

      writeStore(updates);

      res.json({
        success: true,
        data: storeCache,
        serverTime: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Lỗi POST /api/sync:', err);
      res.status(500).json({ success: false, message: (err as Error).message });
    }
  });

  // API GỬI TIN NHẮN TELEGRAM (Tránh lỗi mạng / nhà mạng chặn / CORS trình duyệt)
  app.post('/api/telegram/send', async (req, res) => {
    try {
      const { botToken, chatId, text } = req.body || {};
      if (!botToken || !chatId || !text) {
        return res.status(400).json({
          success: false,
          message: 'Vui lòng cung cấp đầy đủ botToken, chatId và text.',
        });
      }

      let cleanToken = String(botToken).trim();
      if (cleanToken.toLowerCase().startsWith('bot')) {
        cleanToken = cleanToken.slice(3).trim();
      }
      const cleanChatId = String(chatId).trim();

      const telegramUrl = `https://api.telegram.org/bot${cleanToken}/sendMessage`;
      const response = await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: cleanChatId,
          text: text,
          parse_mode: 'HTML',
        }),
      });

      const data = (await response.json()) as any;
      if (data && data.ok) {
        return res.json({
          success: true,
          message: 'Đã gửi thông báo Telegram thành công qua máy chủ!',
        });
      } else {
        let errorMsg = data?.description || 'Không xác định';
        if (errorMsg.includes('chat not found')) {
          errorMsg = 'Chat ID không tồn tại hoặc bot chưa được thêm vào nhóm/chưa bấm /start.';
        } else if (errorMsg.includes('Unauthorized')) {
          errorMsg = 'Bot Token không hợp lệ. Vui lòng kiểm tra lại token từ @BotFather.';
        }
        return res.status(400).json({
          success: false,
          message: `Telegram báo lỗi: ${errorMsg}`,
        });
      }
    } catch (err) {
      console.error('Lỗi POST /api/telegram/send:', err);
      return res.status(500).json({
        success: false,
        message: `Lỗi kết nối máy chủ tới Telegram: ${(err as Error).message}`,
      });
    }
  });

  // Tình trạng kết nối máy chủ
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString(), updatedAt: storeCache.updatedAt });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== 'true' },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.use((_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server chạy trên port ${PORT} - Đồng bộ máy tính & điện thoại sẵn sàng`);
  });
}

startServer().catch((err) => {
  console.error('Khởi động server thất bại:', err);
});
