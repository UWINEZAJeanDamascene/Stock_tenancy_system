const User = require('../models/User');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

// Generate TOTP secret and QR for user to scan
exports.setup2FA = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('+twoFASecret');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const secret = speakeasy.generateSecret({ name: `StockApp (${user.email})` });
    user.twoFASecret = secret.base32;
    user.twoFAConfirmed = false;
    await user.save();

    const otpAuthUrl = secret.otpauth_url;
    const qr = await qrcode.toDataURL(otpAuthUrl);

    res.status(200).json({ success: true, data: { qr, secret: secret.base32 } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Could not set up 2FA' });
  }
};

exports.verify2FA = async (req, res) => {
  try {
    const { token } = req.body;
    const user = await User.findById(req.user._id).select('+twoFASecret');
    if (!user || !user.twoFASecret) return res.status(400).json({ success: false, message: '2FA not configured' });

    const verified = speakeasy.totp.verify({ secret: user.twoFASecret, encoding: 'base32', token, window: 1 });
    if (!verified) return res.status(400).json({ success: false, message: 'Invalid token' });

    user.twoFAEnabled = true;
    user.twoFAConfirmed = true;
    await user.save();

    res.status(200).json({ success: true, message: '2FA verified and enabled' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '2FA verification failed' });
  }
};

exports.disable2FA = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('+twoFASecret');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.twoFAEnabled = false;
    user.twoFASecret = null;
    user.twoFAConfirmed = false;
    await user.save();
    res.status(200).json({ success: true, message: '2FA disabled' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Could not disable 2FA' });
  }
};
