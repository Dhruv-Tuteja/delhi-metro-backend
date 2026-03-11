const express = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { getFirestore } = require('../firebase/firebaseAdmin');
const logger = require('../utils/logger');

const router = express.Router();

// Strict rate limit — 5 reports per hour per IP
const bugReportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many reports submitted. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  next();
};

/**
 * POST /api/bug-reports
 * Submits a bug report from the website help center.
 *
 * Body:
 *   name         string (optional)
 *   email        string (optional)
 *   category     string — 'map_issue' | 'tracking_issue' | 'ui_bug' | 'other'
 *   description  string (required, 20–2000 chars)
 *   appVersion   string (optional)
 *   trackingId   string (optional — attach to a specific journey)
 */
router.post(
  '/',
  bugReportLimiter,
  [
    body('description')
      .isLength({ min: 20, max: 2000 })
      .withMessage('Description must be between 20 and 2000 characters'),
    body('category')
      .isIn(['map_issue', 'tracking_issue', 'ui_bug', 'performance', 'other'])
      .withMessage('Invalid category'),
    body('email').optional().isEmail().normalizeEmail().withMessage('Invalid email'),
  ],
  validate,
  async (req, res) => {
    try {
      const { name, email, category, description, appVersion, trackingId } = req.body;

      const report = {
        name: name?.trim() || 'Anonymous',
        email: email || null,
        category,
        description: description.trim(),
        appVersion: appVersion || 'unknown',
        trackingId: trackingId || null,
        submittedAt: Date.now(),
        status: 'open', // open | investigating | resolved
        ipHash: hashIp(req.ip), // Store hash for abuse prevention, not raw IP
      };

      const ref = await getFirestore().collection('bug_reports').add(report);

      logger.info(`Bug report submitted: ${ref.id} (category: ${category})`);
      return res.status(201).json({
        success: true,
        reportId: ref.id,
        message: 'Thank you for your report. We will look into it shortly.',
      });
    } catch (err) {
      logger.error('Failed to submit bug report', err);
      return res.status(500).json({ success: false, message: 'Failed to submit report. Please try again.' });
    }
  }
);

/**
 * Simple IP hash for abuse prevention (not stored in plain text).
 * @param {string} ip
 * @returns {string}
 */
function hashIp(ip) {
  if (!ip) return 'unknown';
  // Simple non-crypto hash — good enough for abuse detection
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    hash = (hash << 5) - hash + ip.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

module.exports = router;
