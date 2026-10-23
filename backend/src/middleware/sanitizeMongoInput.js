function containsUnsafeMongoKey(value) {
  if (Array.isArray(value)) return value.some(containsUnsafeMongoKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => key.startsWith('$') || key.includes('.') || containsUnsafeMongoKey(child));
}

function sanitizeMongoInput(req, res, next) {
  if (containsUnsafeMongoKey(req.body) || containsUnsafeMongoKey(req.query) || containsUnsafeMongoKey(req.params)) {
    return res.status(400).json({ success: false, error: 'הבקשה מכילה שדות שאינם מורשים.' });
  }
  return next();
}

module.exports = { sanitizeMongoInput, containsUnsafeMongoKey };
