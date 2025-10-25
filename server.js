// VibeXpert Backend Server - Complete Production Version
// Optimized for Render deployment with GitHub Pages frontend
import { sendEmail } from "./utils/sendEmail.js";


require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// ==================== CORS CONFIGURATION ====================
const allowedOrigins = [
  'https://www.vibexpert.online',
  'http://www.vibexpert.online',
  'https://vibexpert.online',
  'http://vibexpert.online',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173'
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn('CORS blocked origin:', origin);
      callback(null, true); // Allow anyway for testing, change to false in production
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Socket.IO CORS
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ==================== ENVIRONMENT VARIABLES ====================
const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || 'production';

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'vibexpert';

// JWT
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// SMTP Email Configuration
const SMTP_HOST = process.env.SMTP_HOST || 'smtp-relay.brevo.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || 'noreply@vibexpert.online';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'VibeXpert';

// ==================== VALIDATION ====================
const requiredEnvVars = {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: SUPABASE_KEY,
  JWT_SECRET
};

const missingVars = Object.entries(requiredEnvVars)
  .filter(([_, value]) => !value)
  .map(([key]) => key);

if (missingVars.length > 0) {
  console.error('❌ FATAL ERROR: Missing required environment variables:');
  missingVars.forEach(varName => console.error(`   - ${varName}`));
  console.error('\nPlease set these in your Render dashboard Environment settings.');
  process.exit(1);
}

// ==================== INITIALIZE SERVICES ====================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// SMTP Email Transporter
let emailTransporter = null;
if (SMTP_USER && SMTP_PASS) {
  emailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    },
    tls: {
      rejectUnauthorized: false
    }
  });

  // Verify SMTP connection
  emailTransporter.verify((error, success) => {
    if (error) {
      console.error('❌ SMTP connection failed:', error.message);
      emailTransporter = null;
    } else {
      console.log('✅ SMTP server ready to send emails');
    }
  });
} else {
  console.warn('⚠️  SMTP not configured - emails will not be sent');
  console.warn('   Set SMTP_USER and SMTP_PASS in environment variables');
}

// ==================== FILE UPLOAD MIDDLEWARE ====================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
    }
  }
});

// ==================== HELPER FUNCTIONS ====================

// Generate JWT Token
function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// Send Email via SMTP
async function sendEmail({ to, subject, html, text }) {
  if (!emailTransporter) {
    console.warn('⚠️  Email not sent - SMTP not configured:', to);
    return { success: false, error: 'SMTP not configured' };
  }

  try {
    const mailOptions = {
      from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
      to,
      subject,
      html: html || text,
      text: text || html?.replace(/<[^>]*>/g, '') || ''
    };

    const info = await emailTransporter.sendMail(mailOptions);
    console.log('✅ Email sent:', to, '|', subject, '| ID:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Email failed:', to, '|', error.message);
    return { success: false, error: error.message };
  }
}

// ==================== AUTHENTICATION MIDDLEWARE ====================
async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Authorization header missing or invalid'
      });
    }

    const token = authHeader.split(' ')[1];
    
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          error: 'Token expired. Please login again.'
        });
      }
      throw jwtError;
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', decoded.id)
      .single();

    if (error || !user) {
      return res.status(401).json({
        success: false,
        error: 'User not found'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(401).json({
      success: false,
      error: 'Authentication failed'
    });
  }
}

// ==================== ROUTES ====================

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'VibeXpert Backend API',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: NODE_ENV,
    services: {
      database: !!SUPABASE_URL,
      email: !!emailTransporter,
      storage: !!STORAGE_BUCKET
    },
    smtp: emailTransporter ? {
      configured: true,
      host: SMTP_HOST,
      port: SMTP_PORT,
      user: SMTP_USER?.substring(0, 8) + '***',
      from: SMTP_FROM_EMAIL
    } : {
      configured: false
    }
  });
});

// Root Endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'VibeXpert API',
    version: '1.0.0',
    status: 'running',
    documentation: 'https://github.com/yourusername/vibexpert-backend',
    endpoints: {
      health: 'GET /api/health',
      register: 'POST /api/register',
      login: 'POST /api/login',
      forgotPassword: 'POST /api/forgot-password',
      resetPassword: 'POST /api/verify-reset-code'
    }
  });
});

// ==================== AUTH ROUTES ====================

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username, email, and password are required'
      });
    }

    if (username.length < 3) {
      return res.status(400).json({
        success: false,
        error: 'Username must be at least 3 characters'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters'
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    // Check if email exists
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Email already registered'
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{
        username,
        email,
        password_hash: passwordHash,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (insertError) {
      console.error('User creation error:', insertError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create account'
      });
    }

    // Send welcome email (non-blocking)
    const welcomeEmail = {
      to: email,
      subject: 'Welcome to VibeXpert! 🎉',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
          <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 20px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 32px;">Welcome to VibeXpert! 🎓</h1>
            </div>
            <div style="padding: 40px 30px;">
              <h2 style="color: #333; margin-top: 0;">Hi ${username}! 👋</h2>
              <p style="color: #666; font-size: 16px; line-height: 1.6;">
                Your account has been successfully created. You're now part of the VibeXpert community!
              </p>
              <div style="background: #f8f9fa; border-left: 4px solid #667eea; padding: 20px; margin: 20px 0;">
                <p style="margin: 0 0 10px 0; color: #333; font-weight: bold;">What's next?</p>
                <ul style="color: #666; margin: 0; padding-left: 20px;">
                  <li>Join your college community</li>
                  <li>Connect with fellow students</li>
                  <li>Share posts and experiences</li>
                  <li>Discover campus events</li>
                </ul>
              </div>
              <div style="text-align: center; margin: 30px 0;">
                <a href="https://www.vibexpert.online" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 40px; border-radius: 25px; font-weight: bold; font-size: 16px;">Get Started</a>
              </div>
              <p style="color: #999; font-size: 14px; margin-top: 30px; text-align: center;">
                Best regards,<br>
                <strong>The VibeXpert Team</strong>
              </p>
            </div>
            <div style="background: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #e0e0e0;">
              <p style="color: #999; font-size: 12px; margin: 0;">
                © 2025 VibeXpert. All rights reserved.
              </p>
            </div>
          </div>
        </body>
        </html>
      `
    };

    sendEmail(welcomeEmail).catch(err => {
      console.error('Welcome email failed:', err);
    });

    // Generate token
    const token = signToken(newUser);

    res.status(201).json({
      success: true,
      message: 'Account created successfully! Welcome email sent.',
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        college: newUser.college,
        communityJoined: newUser.community_joined || false
      },
      token
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Registration failed. Please try again.'
    });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    // Find user
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Generate token
    const token = signToken(user);

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        college: user.college,
        communityJoined: user.community_joined || false,
        profilePic: user.profile_pic
      },
      token
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed. Please try again.'
    });
  }
});

// Forgot Password
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    // Find user (don't reveal if email exists for security)
    const { data: user } = await supabase
      .from('users')
      .select('id, username, email')
      .eq('email', email)
      .single();

    // Always return success to prevent email enumeration
    if (!user) {
      return res.json({
        success: true,
        message: 'If the email exists, a reset code has been sent.'
      });
    }

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Save code to database
    const { error: codeError } = await supabase
      .from('codes')
      .insert([{
        user_id: user.id,
        code,
        type: 'reset',
        expires_at: expiresAt.toISOString(),
        used: false,
        created_at: new Date().toISOString()
      }]);

    if (codeError) {
      console.error('Code save error:', codeError);
      return res.status(500).json({
        success: false,
        error: 'Failed to generate reset code'
      });
    }

    // Send reset email
    const resetEmail = {
      to: email,
      subject: 'Password Reset Code - VibeXpert',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
          <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 20px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 32px;">Password Reset 🔒</h1>
            </div>
            <div style="padding: 40px 30px;">
              <h2 style="color: #333; margin-top: 0;">Hi ${user.username}! 👋</h2>
              <p style="color: #666; font-size: 16px; line-height: 1.6;">
                You requested to reset your password. Use the code below:
              </p>
              <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px; margin: 30px 0;">
                <div style="color: white; font-size: 48px; font-weight: bold; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                  ${code}
                </div>
              </div>
              <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 15px; margin: 20px 0;">
                <p style="margin: 0; color: #856404; font-size: 14px;">
                  ⏰ <strong>This code expires in 15 minutes.</strong>
                </p>
              </div>
              <p style="color: #666; font-size: 14px; line-height: 1.6;">
                If you didn't request this, please ignore this email. Your password will remain unchanged.
              </p>
              <p style="color: #999; font-size: 14px; margin-top: 30px; text-align: center;">
                Best regards,<br>
                <strong>The VibeXpert Team</strong>
              </p>
            </div>
            <div style="background: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #e0e0e0;">
              <p style="color: #999; font-size: 12px; margin: 0;">
                © 2025 VibeXpert. All rights reserved.
              </p>
            </div>
          </div>
        </body>
        </html>
      `
    };

    await sendEmail(resetEmail);

    res.json({
      success: true,
      message: 'If the email exists, a reset code has been sent.'
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process request'
    });
  }
});

// Verify Reset Code & Reset Password
app.post('/api/verify-reset-code', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Email, code, and new password are required'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters'
      });
    }

    // Find user
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (!user) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email'
      });
    }

    // Verify code
    const { data: codeRow } = await supabase
      .from('codes')
      .select('*')
      .eq('user_id', user.id)
      .eq('code', code)
      .eq('type', 'reset')
      .eq('used', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!codeRow) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or already used code'
      });
    }

    if (new Date(codeRow.expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        error: 'Code has expired. Please request a new one.'
      });
    }

    // Update password
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const { error: updateError } = await supabase
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('id', user.id);

    if (updateError) {
      console.error('Password update error:', updateError);
      return res.status(500).json({
        success: false,
        error: 'Failed to update password'
      });
    }

    // Mark code as used
    await supabase
      .from('codes')
      .update({ used: true })
      .eq('id', codeRow.id);

    res.json({
      success: true,
      message: 'Password reset successfully! You can now login.'
    });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reset password'
    });
  }
});

// ==================== COLLEGE/COMMUNITY ROUTES ====================

// Select College (Send Verification Code)
app.post('/api/select-college', authMiddleware, async (req, res) => {
  try {
    const { college } = req.body;

    if (!college) {
      return res.status(400).json({
        success: false,
        error: 'College name is required'
      });
    }

    if (req.user.community_joined) {
      return res.status(400).json({
        success: false,
        error: 'You have already joined a community'
      });
    }

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    // Save code
    const { error: codeError } = await supabase
      .from('codes')
      .insert([{
        user_id: req.user.id,
        code,
        type: 'college',
        meta: { college },
        expires_at: expiresAt.toISOString(),
        used: false,
        created_at: new Date().toISOString()
      }]);

    if (codeError) {
      console.error('College code save error:', codeError);
      return res.status(500).json({
        success: false,
        error: 'Failed to generate confirmation code'
      });
    }

    // Send verification email
    const verificationEmail = {
      to: req.user.email,
      subject: `Confirm Joining ${college} - VibeXpert`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
          <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 20px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 32px;">Confirm Your College 🎓</h1>
            </div>
            <div style="padding: 40px 30px;">
              <h2 style="color: #333; margin-top: 0;">Hi ${req.user.username}! 👋</h2>
              <p style="color: #666; font-size: 16px; line-height: 1.6;">
                To confirm joining <strong style="color: #667eea;">${college}</strong>, use the code below:
              </p>
              <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px; margin: 30px 0;">
                <div style="color: white; font-size: 48px; font-weight: bold; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                  ${code}
                </div>
              </div>
              <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 15px; margin: 20px 0;">
                <p style="margin: 0; color: #856404; font-size: 14px;">
                  ⏰ <strong>This code expires in 30 minutes.</strong>
                </p>
              </div>
              <p style="color: #999; font-size: 14px; margin-top: 30px; text-align: center;">
                Best regards,<br>
                <strong>The VibeXpert Team</strong>
              </p>
            </div>
            <div style="background: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #e0e0e0;">
              <p style="color: #999; font-size: 12px; margin: 0;">
                © 2025 VibeXpert. All rights reserved.
              </p>
            </div>
          </div>
        </body>
        </html>
      `
    };

    await sendEmail(verificationEmail);

    res.json({
      success: true,
      message: 'Verification code sent to your email'
    });

  } catch (error) {
    console.error('Select college error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send verification code'
    });
  }
});

// Verify College Code
app.post('/api/verify-college-code', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Verification code is required'
      });
    }

    // Verify code
    const { data: codeRow } = await supabase
      .from('codes')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('code', code)
      .eq('type', 'college')
      .eq('used', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!codeRow) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or already used code'
      });
    }

    if (new Date(codeRow.expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        error: 'Code has expired. Please request a new one.'
      });
    }

    const college = codeRow.meta?.college;
    if (!college) {
      return res.status(500).json({
        success: false,
        error: 'Invalid code data'
      });
    }

    // Update user
    const { error: updateError } = await supabase
      .from('users')
      .update({
        college,
        community_joined: true
      })
      .eq('id', req.user.id);

    if (updateError) {
      console.error('User update error:', updateError);
      return res.status(500).json({
        success: false,
        error: 'Failed to join community'
      });
    }

    // Mark code as used
    await supabase
      .from('codes')
      .update({ used: true })
      .eq('id', codeRow.id);

    res.json({
      success: true,
      message: `Successfully joined ${college}!`,
      college
    });

  } catch (error) {
    console.error('Verify college code error:', error);
    res.status(500).json({
      success: false,
      error: 'Verification failed'
    });
  }
});

// ==================== CHAT/MESSAGE ROUTES ====================

// Get Community Chat Messages
app.get('/api/community/chat', authMiddleware, async (req, res) => {
  try {
    if (!req.user.community_joined) {
      return res.status(403).json({
        success: false,
        error: 'You must join a community first'
      });
    }

    const { data: messages, error } = await supabase
      .from('messages')
      .select(`
        *,
        users:sender_id (
          id,
          username,
          profile_pic
        )
      `)
      .order('timestamp', { ascending: true })
      .limit(500);

    if (error) {
      console.error('Fetch messages error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch messages'
      });
    }

    res.json({
      success: true,
      messages: messages || []
    });

  } catch (error) {
    console.error('Community chat error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch messages'
    });
  }
});

// Post Community Message
app.post('/api/community/message', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    if (!req.user.community_joined) {
      return res.status(403).json({
        success: false,
        error: 'You must join a community first'
      });
    }

    const { content } = req.body;
    let imageUrl = null;

    // Handle image upload
    if (req.file) {
      const filename = `chat/${req.user.id}/${Date.now()}_${uuidv4()}.${req.file.mimetype.split('/')[1]}`;
      
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(filename, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false
        });

      if (uploadError) {
        console.error('Image upload error:', uploadError);
        return res.status(500).json({
          success: false,
          error: 'Failed to upload image'
        });
      }

      const { data: urlData } = supabase.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(filename);
      
      imageUrl = urlData.publicUrl;
    }

    if (!content && !imageUrl) {
      return res.status(400).json({
        success: false,
        error: 'Message must have content or image'
      });
    }

    // Insert message
    const { data: message, error: insertError } = await supabase
      .from('messages')
      .insert([{
        sender_id: req.user.id,
        content: content || null,
        image_url: imageUrl,
        timestamp: new Date().toISOString()
      }])
      .select(`
        *,
        users:sender_id (
          id,
          username,
          profile_pic
        )
      `)
      .single();

    if (insertError) {
      console.error('Message insert error:', insertError);
      return res.status(500).json({
        success: false,
        error: 'Failed to send message'
      });
    }

    // Emit via Socket.IO
    io.emit('new_message', message);

    res.json({
      success: true,
      message
    });

  } catch (error) {
    console.error('Post message error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send message'
    });
  }
});

// ==================== POST ROUTES ====================

// Upload Post
app.post('/api/post/upload', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Image is required'
      });
    }

    const { caption, postedTo } = req.body;

    if (!['profile', 'community'].includes(postedTo)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid postedTo value. Must be "profile" or "community"'
      });
    }

    // Upload image to Supabase Storage
    const filename = `posts/${req.user.id}/${Date.now()}_${uuidv4()}.${req.file.mimetype.split('/')[1]}`;
    
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError) {
      console.error('Post upload error:', uploadError);
      return res.status(500).json({
        success: false,
        error: 'Failed to upload image'
      });
    }

    const { data: urlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(filename);

    // Create post
    const { data: post, error: postError } = await supabase
      .from('posts')
      .insert([{
        user_id: req.user.id,
        image_url: urlData.publicUrl,
        caption: caption || '',
        posted_to: postedTo,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (postError) {
      console.error('Post create error:', postError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create post'
      });
    }

    res.json({
      success: true,
      post
    });

  } catch (error) {
    console.error('Upload post error:', error);
    res.status(500).json({
      success: false,
      error: 'Upload failed'
    });
  }
});

// Get Posts
app.get('/api/posts', authMiddleware, async (req, res) => {
  try {
    const { type } = req.query; // 'community' or 'profile'

    let query = supabase
      .from('posts')
      .select(`
        *,
        users:user_id (
          id,
          username,
          profile_pic
        )
      `)
      .order('created_at', { ascending: false });

    if (type === 'profile') {
      query = query.eq('user_id', req.user.id);
    } else if (type === 'community') {
      query = query.eq('posted_to', 'community');
    }

    const { data: posts, error } = await query.limit(50);

    if (error) {
      console.error('Fetch posts error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch posts'
      });
    }

    res.json({
      success: true,
      posts: posts || []
    });

  } catch (error) {
    console.error('Get posts error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch posts'
    });
  }
});

// ==================== USER ROUTES ====================

// Get User Profile
app.get('/api/user/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.params.id;

    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email, profile_pic, liked_profiles, college, community_joined, created_at')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      user
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user'
    });
  }
});

// Get Current User Profile
app.get('/api/user/me', authMiddleware, async (req, res) => {
  try {
    res.json({
      success: true,
      user: {
        id: req.user.id,
        username: req.user.username,
        email: req.user.email,
        profilePic: req.user.profile_pic,
        college: req.user.college,
        communityJoined: req.user.community_joined,
        likedProfiles: req.user.liked_profiles || []
      }
    });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user'
    });
  }
});

// Like User Profile
app.post('/api/user/:id/like', authMiddleware, async (req, res) => {
  try {
    const targetId = req.params.id;

    if (targetId === req.user.id) {
      return res.status(400).json({
        success: false,
        error: 'Cannot like your own profile'
      });
    }

    const likedProfiles = req.user.liked_profiles || [];

    if (likedProfiles.includes(targetId)) {
      return res.json({
        success: true,
        message: 'Already liked this profile'
      });
    }

    likedProfiles.push(targetId);

    const { error } = await supabase
      .from('users')
      .update({ liked_profiles: likedProfiles })
      .eq('id', req.user.id);

    if (error) {
      console.error('Like profile error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to like profile'
      });
    }

    res.json({
      success: true,
      message: 'Profile liked successfully'
    });

  } catch (error) {
    console.error('Like user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to like profile'
    });
  }
});

// Update User Profile
app.put('/api/user/profile', authMiddleware, upload.single('profilePic'), async (req, res) => {
  try {
    const { username } = req.body;
    const updates = {};

    if (username && username !== req.user.username) {
      if (username.length < 3) {
        return res.status(400).json({
          success: false,
          error: 'Username must be at least 3 characters'
        });
      }
      updates.username = username;
    }

    // Handle profile picture upload
    if (req.file) {
      const filename = `profiles/${req.user.id}/${Date.now()}_${uuidv4()}.${req.file.mimetype.split('/')[1]}`;
      
      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(filename, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false
        });

      if (uploadError) {
        console.error('Profile pic upload error:', uploadError);
        return res.status(500).json({
          success: false,
          error: 'Failed to upload profile picture'
        });
      }

      const { data: urlData } = supabase.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(filename);
      
      updates.profile_pic = urlData.publicUrl;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No updates provided'
      });
    }

    // Update user
    const { data: updatedUser, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) {
      console.error('Profile update error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update profile'
      });
    }

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        profilePic: updatedUser.profile_pic
      }
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update profile'
    });
  }
});

// Delete Account
app.delete('/api/user/delete', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', req.user.id);

    if (error) {
      console.error('Delete account error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete account'
      });
    }

    res.json({
      success: true,
      message: 'Account deleted successfully'
    });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete account'
    });
  }
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
  console.log('✅ Socket connected:', socket.id);

  // Send Message via Socket
  socket.on('send_message', async (payload) => {
    try {
      const { token, content, imageBase64 } = payload;

      if (!token) {
        return socket.emit('error', { error: 'Token required' });
      }

      const decoded = jwt.verify(token, JWT_SECRET);
      
      const { data: user } = await supabase
        .from('users')
        .select('*')
        .eq('id', decoded.id)
        .single();

      if (!user || !user.community_joined) {
        return socket.emit('error', { error: 'Not authorized to send messages' });
      }

      let imageUrl = null;

      // Handle base64 image if provided
      if (imageBase64) {
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const filename = `chat/${user.id}/${Date.now()}_${uuidv4()}.png`;

        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(filename, buffer, {
            contentType: 'image/png',
            upsert: false
          });

        if (!uploadError) {
          const { data: urlData } = supabase.storage
            .from(STORAGE_BUCKET)
            .getPublicUrl(filename);
          imageUrl = urlData.publicUrl;
        }
      }

      // Insert message
      const { data: message } = await supabase
        .from('messages')
        .insert([{
          sender_id: user.id,
          content: content || null,
          image_url: imageUrl,
          timestamp: new Date().toISOString()
        }])
        .select(`
          *,
          users:sender_id (
            id,
            username,
            profile_pic
          )
        `)
        .single();

      // Broadcast to all connected clients
      io.emit('new_message', message);

    } catch (error) {
      console.error('Socket send_message error:', error);
      socket.emit('error', { error: 'Failed to send message' });
    }
  });

  // React to Message
  socket.on('react', async ({ token, messageId, type }) => {
    try {
      if (!token) {
        return socket.emit('error', { error: 'Token required' });
      }

      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;

      const { data: message } = await supabase
        .from('messages')
        .select('*')
        .eq('id', messageId)
        .single();

      if (!message) return;

      const reactions = Array.isArray(message.reactions) ? message.reactions : [];
      reactions.push({
        userId,
        type,
        at: new Date().toISOString()
      });

      await supabase
        .from('messages')
        .update({ reactions })
        .eq('id', messageId);

      io.emit('reaction', { messageId, reactions });

    } catch (error) {
      console.error('Socket react error:', error);
      socket.emit('error', { error: 'Failed to react' });
    }
  });

  socket.on('disconnect', () => {
    console.log('❌ Socket disconnected:', socket.id);
  });
});

// ==================== ERROR HANDLING ====================

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path,
    method: req.method
  });
});

// Global Error Handler
app.use((error, req, res, next) => {
  console.error('Global error handler:', error);

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File too large. Maximum size is 10MB'
      });
    }
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: NODE_ENV === 'development' ? error.message : undefined
  });
});

// ==================== START SERVER ====================

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '═'.repeat(70));
  console.log('🚀 VibeXpert Backend Server Started Successfully!');
  console.log('═'.repeat(70));
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`🕐 Started at: ${new Date().toLocaleString()}`);
  console.log('─'.repeat(70));
  console.log('📦 Services:');
  console.log(`   ├─ Database (Supabase): ${SUPABASE_URL ? '✅ Connected' : '❌ Not configured'}`);
  console.log(`   ├─ Storage Bucket: ${STORAGE_BUCKET}`);
  console.log(`   ├─ JWT Auth: ${JWT_SECRET ? '✅ Configured' : '❌ Missing'}`);
  console.log(`   └─ Email (SMTP): ${emailTransporter ? '✅ Ready' : '⚠️  Not configured'}`);
  
  if (emailTransporter) {
    console.log('─'.repeat(70));
    console.log('📧 Email Configuration:');
    console.log(`   ├─ SMTP Host: ${SMTP_HOST}:${SMTP_PORT}`);
    console.log(`   ├─ SMTP User: ${SMTP_USER?.substring(0, 10)}***`);
    console.log(`   └─ From Email: ${SMTP_FROM_EMAIL}`);
  }
  
  console.log('─'.repeat(70));
  console.log('🌐 API Endpoints:');
  console.log(`   ├─ Health: https://vibexpert-backend-main.onrender.com/api/health`);
  console.log(`   ├─ Register: POST /api/register`);
  console.log(`   ├─ Login: POST /api/login`);
  console.log(`   └─ Docs: https://vibexpert-backend-main.onrender.com`);
  console.log('─'.repeat(70));
  console.log('🖥️  Frontend: https://www.vibexpert.online');
  console.log('🔌 WebSocket: ✅ Active on port ' + PORT);
  console.log('═'.repeat(70) + '\n');
  console.log('✅ Server is ready to accept connections!\n');
});

