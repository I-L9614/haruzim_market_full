require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { Admin, Category, Product } = require('./src/models');
const orderRoutes = require('./src/routes/orderRoutes');
const analyticsRoutes = require('./src/routes/analytics');
const adminOrderRoutes = require('./src/routes/adminOrders');
const managerRoutes = require('./src/routes/managers');
const adminProductRoutes = require('./src/routes/adminProducts');
const adminCatalogRoutes = require('./src/routes/adminCatalog');
const customerAuthRoutes = require('./src/routes/customerAuth');
const customerOrderRoutes = require('./src/routes/customerOrders');
const { getFeaturedProduct } = require('./src/controllers/adminCatalogController');
const { requireAuth } = require('./src/middleware/auth');
const { getShabbatStatus, shabbatMiddleware } = require('./src/middleware/shabbat');
const { createRateLimit } = require('./src/middleware/rateLimit');
const { sanitizeMongoInput } = require('./src/middleware/sanitizeMongoInput');
const { errorHandler } = require('./src/middleware/errorHandler');
const logger = require('./src/logger');
const { seedAdmin } = require('./scripts/seedAdmin');
const { ensureCustomerIndexes } = require('./scripts/ensureCustomerIndexes');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors({ origin: true, credentials: true }));
const httpServer = http.createServer(app);
const allowedOrigins = (process.env.CLIENT_ORIGIN || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173,http://localhost:5174,http://localhost:3000,http://localhost:3001,http://localhost:3002,http://192.168.32.1:3001'))
  .split(',').map((origin) => origin.trim()).filter(Boolean);
if (process.env.ELECTRON_ORIGIN) allowedOrigins.push(process.env.ELECTRON_ORIGIN.trim());
const isAllowedOrigin = (origin) => !origin || allowedOrigins.includes(origin);
const corsOrigin = (origin, callback) => callback(null, isAllowedOrigin(origin));
const io = new Server(httpServer, {
  cors: { origin: corsOrigin },
  allowRequest: (request, callback) => callback(null, isAllowedOrigin(request.headers.origin))
});
global.io = io;
const port = Number(process.env.PORT || 3000);

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const admin = await Admin.findById(decoded.id).select('role active').lean();
    if (!admin?.active || !['admin', 'manager'].includes(admin.role)) return next(new Error('Forbidden'));
    socket.user = { id: String(decoded.id), role: admin.role };
    return next();
  } catch (error) {
    return next(new Error('Invalid authentication token'));
  }
});
io.on('connection', (socket) => socket.join(`admin:${socket.user.id}`));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", 'https://accounts.google.com', 'https://www.gstatic.com'],
      'frame-src': ["'self'", 'https://accounts.google.com'],
      'connect-src': ["'self'", 'https://accounts.google.com', 'https://www.googleapis.com']
    }
  }
}));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ success: false, error: 'מקור הבקשה אינו מורשה.' });
  }
  return next();
});
app.use(express.json({ limit: '1mb' }));
app.use(sanitizeMongoInput);
app.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
      const readableError = body.message || (typeof body.error === 'string' && !/^[A-Z0-9_]+$/.test(body.error) ? body.error : 'הבקשה לא הצליחה.');
      return sendJson({ ...body, success: false, error: readableError });
    }
    return sendJson(body);
  };
  return next();
});
app.use(morgan(':method :status :response-time ms', { stream: { write: (line) => logger.info(line.trim()) } }));
app.use('/api', createRateLimit({ windowMs: 15 * 60 * 1000, max: 600 }));
app.get('/api/health', (req, res) => {
  const ready = mongoose.connection.readyState === 1;
  return res.status(ready ? 200 : 503).json({ ok: ready, database: ready ? 'connected' : 'disconnected', service: 'haruzim-market-api' });
});
app.get('/api/shabbat/status', async (req, res, next) => {
  try {
    const status = await getShabbatStatus();
    return res.json({ success: true, ...status });
  } catch (error) {
    return next(error);
  }
});
app.get('/api/catalog', async (req, res, next) => {
  try {
    const filter = { active: true };
    if (req.query.category) filter.category = req.query.category;
    if (req.query.search) filter.$text = { $search: req.query.search };

    const products = await Product.find(filter).populate('category', 'name slug').sort({ name: 1 });
    res.json({ products });
  } catch (error) {
    next(error);
  }
});

app.get('/api/categories', async (req, res, next) => {
  try {
    const categories = await Category.find({ active: true }).sort({ name: 1 });
    res.json({ categories });
  } catch (error) {
    next(error);
  }
});
app.get('/api/featured-product', getFeaturedProduct);

app.post('/api/auth/admin/login', createRateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'בוצעו יותר מדי ניסיונות התחברות. נסו שוב בעוד 15 דקות.' }), async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const admin = await Admin.findOne({ email: String(email || '').trim().toLowerCase(), active: true });

    if (!admin || !(await bcrypt.compare(password || '', admin.passwordHash || ''))) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'אימייל או סיסמה שגויים.' });
    }

    const token = jwt.sign({ id: admin._id, email: admin.email, role: admin.role }, process.env.JWT_SECRET, { expiresIn: '12h' });
    return res.json({ token, admin: { id: admin._id, name: admin.name, email: admin.email, role: admin.role } });
  } catch (error) {
    return next(error);
  }
});
app.get('/api/auth/admin/me', requireAuth, (req, res) => res.json({ admin: req.user }));
app.use('/api/auth/customer', customerAuthRoutes);

app.use('/api', orderRoutes);
app.use('/api/customer/orders', customerOrderRoutes);
app.use('/api/admin', analyticsRoutes);
app.use('/api/admin/orders', adminOrderRoutes);
app.use('/api/admin/managers', managerRoutes);
app.use('/api/admin/products', adminProductRoutes);
app.use('/api/admin/catalog', adminCatalogRoutes);

app.use(errorHandler);

async function start() {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI must be configured before starting the API.');
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('Set JWT_SECRET to a random value of at least 32 characters.');
  }
  if (process.env.NODE_ENV === 'production' && (!allowedOrigins.length || allowedOrigins.includes('*') || allowedOrigins.some((origin) => /localhost|127\.0\.0\.1/.test(origin)))) {
    throw new Error('Configure only production HTTPS origins in CLIENT_ORIGIN before starting in production.');
  }

  await mongoose.connect(process.env.MONGO_URI);
  await ensureCustomerIndexes();
  await seedAdmin();
  httpServer.listen(port, () => logger.info(`Haruzim Market API listening on port ${port}`));
}

if (require.main === module) {
  start().catch((error) => {
    logger.error('API failed to start', { code: error.code || error.name, stack: error.stack });
    process.exit(1);
  });
}

module.exports = { app, start, io };
