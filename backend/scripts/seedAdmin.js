const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { Admin } = require('../src/models');
const logger = require('../src/logger');

async function seedAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';

  const ownsConnection = mongoose.connection.readyState === 0;
  if (ownsConnection) {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required to seed an administrator.');
    await mongoose.connect(process.env.MONGO_URI);
  }

  if (!email || password.length < 12) {
    const existingAdmin = await Admin.exists({});
    if (existingAdmin) {
      logger.info('Admin seeding skipped; credentials are not configured');
      if (ownsConnection) await mongoose.disconnect();
      return;
    }
    if (ownsConnection) await mongoose.disconnect();
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) to seed the first administrator.');
  }

  const existing = await Admin.findOne({ email }).lean();
  if (existing) {
    logger.info('Initial admin already exists');
    if (ownsConnection) await mongoose.disconnect();
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await Admin.create({
    name: process.env.ADMIN_NAME || 'Store Admin',
    email,
    passwordHash,
    role: 'admin',
    active: true
  });

  logger.info('Initial admin created');
  if (ownsConnection) await mongoose.disconnect();
}

module.exports = { seedAdmin };

if (require.main === module) {
  seedAdmin().catch((error) => {
    logger.error('Initial admin seeding failed', { code: error.code || error.name, stack: error.stack });
    process.exit(1);
  });
}
