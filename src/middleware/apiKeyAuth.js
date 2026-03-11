const logger = require('../utils/logger');

/**
 * Middleware that requires a valid API key for Android→Backend communication.
 * The key is set in .env (API_SECRET_KEY) and hardcoded in the Android app's BuildConfig.
 *
 * Usage: apply to routes that should only be called by the Android app (not the website).
 */
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];

  if (!process.env.API_SECRET_KEY) {
    // If no key is configured, allow in development
    if (process.env.NODE_ENV !== 'production') return next();
    logger.warn('API_SECRET_KEY not configured in production!');
    return res.status(500).json({ success: false, message: 'Server misconfiguration' });
  }

  if (!key || key !== process.env.API_SECRET_KEY) {
    logger.warn(`Unauthorized API request from ${req.ip}`);
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  next();
}

module.exports = { requireApiKey };
