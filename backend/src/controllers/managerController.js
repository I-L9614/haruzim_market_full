const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { Admin } = require('../models');

async function listManagers(req, res, next) {
  try {
    const managers = await Admin.find({ role: 'manager' })
      .select('name email role active createdAt updatedAt')
      .sort({ active: -1, name: 1 })
      .lean();
    return res.json({ managers });
  } catch (error) {
    return next(error);
  }
}

async function createManager(req, res, next) {
  try {
    const { name, email, password } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPassword = String(password || '');
    if (cleanName.length < 2 || cleanName.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanPassword.length < 12 || cleanPassword.length > 128) {
      return res.status(400).json({
        error: 'INVALID_MANAGER',
        message: 'יש להזין שם תקין, כתובת אימייל וסיסמה באורך 12 תווים לפחות.'
      });
    }

    const passwordHash = await bcrypt.hash(cleanPassword, 12);
    const manager = await Admin.create({
      name: cleanName,
      email: cleanEmail,
      passwordHash,
      role: 'manager',
      active: true
    });
    return res.status(201).json({
      manager: {
        _id: manager._id,
        name: manager.name,
        email: manager.email,
        role: manager.role,
        active: manager.active,
        createdAt: manager.createdAt
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'EMAIL_IN_USE', message: 'כבר קיים חשבון עם כתובת האימייל הזו.' });
    }
    return next(error);
  }
}

async function deactivateManager(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'INVALID_MANAGER_ID', message: 'מזהה המנהל אינו תקין.' });
    }
    const manager = await Admin.findOneAndUpdate(
      { _id: req.params.id, role: 'manager', active: true },
      { $set: { active: false } },
      { new: true, runValidators: true }
    ).select('name email role active createdAt updatedAt');

    if (!manager) {
      return res.status(404).json({ error: 'MANAGER_NOT_FOUND', message: 'המנהל לא נמצא או שכבר הוסר.' });
    }
    if (global.io) global.io.in(`admin:${manager._id}`).disconnectSockets(true);
    return res.json({ manager });
  } catch (error) {
    return next(error);
  }
}

module.exports = { listManagers, createManager, deactivateManager };