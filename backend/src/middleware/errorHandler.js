const logger = require('../logger');

function getErrorResponse(error, production) {
  const status = error.status || (error.name === 'ValidationError' || error.name === 'CastError' ? 400 : error.code === 11000 ? 409 : 500);
  const safeMessage = status >= 500
    ? 'אירעה שגיאה במערכת. נסו שוב מאוחר יותר.'
    : (error.publicMessage || error.message || 'הבקשה לא הצליחה.');
  return {
    status,
    body: {
      success: false,
      error: safeMessage,
      ...(error.code && !production ? { code: String(error.code) } : {})
    }
  };
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const result = getErrorResponse(error, process.env.NODE_ENV === 'production');
  logger.error('API request failed', {
    code: error.code || error.name,
    status: result.status,
    stack: error.stack
  });
  return res.status(result.status).json(result.body);
}

module.exports = { errorHandler, getErrorResponse };
