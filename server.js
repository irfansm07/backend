// server.js - Production Ready with SMTP Email
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

// CORS Configuration
const allowedOrigins = [
  'http://www.vibexpert.online',
  'https://www.vibexpert.online',
  'http://vibexpert.online',
  'https://vibexpert.online',
  'http://localhost:3000',
  'http://localhost:5173'
];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    return callback(new Error('CORS policy violation'), false);
  },
  credentials: true
}));

app.use(express.json());

// Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'vibexpert';

// SMTP Configuration
const SMTP_HOST = process.env.SMTP_HOST || 'smtp-relay.brevo.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || 'noreply@vibexpert.online';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'VibeXpert';

// Validate critical environment variables
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ FATAL: Missing SUPABASE credentials');
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error('❌ FATAL: Missing JWT_SECRET');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Create SMTP transporter
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
      console.log('✅ SMTP server is ready to send emails');
    }
  });
} else {
  console.warn('⚠️  WARNING: SMTP not configured. Emails will not be sent.');
  console.warn('   Required: SMTP_USER and SMTP_PASS');
}

// File upload middleware
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Helper: JWT signing
function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email }, 
    JWT_SECRET, 
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// Helper: Send email via SMTP
async function sendEmail({ to, subject, html, text }) {
  if (!emailTransporter) {
    console.warn('⚠️  SMTP not configured. Email not sent to:', to);
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
    console.log('✅ Email sent successfully:', {
      to,
      subject,
      messageId: info.messageId
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('❌ Email sending failed:', {
      to,
      subject,
      error: err.message
    });
    return { success: false, error: err.message };
  }
}

// Auth middleware
async function authMiddleware(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization header missing or invalid' });
    }

    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', decoded.id)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// --- ROUTES ---

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'VibeXpert Backend is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'production',
    email: {
      configured: !!emailTransporter,
      smtp_host: SMTP_HOST,
      smtp_port: SMTP_PORT,
      smtp_user: SMTP_USER ? SMTP_USER.substring(0, 5) + '***' : 'Not set',
      from_email: SMTP_FROM_EMAIL
    },
    database: {
      connected: !!SUPABASE_URL
    }
  });
});

// Root route
app.get('/', (req, res) => {
  res.json({ 
    message: '🎓 VibeXpert Backend API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/api/health',
      register: 'POST /api/register',
      login: 'POST /api/login',
      forgotPassword: 'POST /api/forgot-password'
    }
  });
});

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if email already exists
    const { data: existing, error: existErr } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existErr) {
      console.error('Database error:', existErr);
      return res.status(500).json({ error: 'Database error' });
    }

    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const pwHash = await bcrypt.hash(password, 10);

    // Create user
    const { data: newUser, error: insertErr } = await supabase
      .from('users')
      .insert({
        username,
        email,
        password_hash: pwHash,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertErr) {
      console.error('Database error:', insertErr);
      return res.status(500).json({ error: 'Failed to create account' });
    }

    // Send welcome email (non-blocking)
    const subject = 'Welcome to VibeXpert 🎉';
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 20px;">
          <div style="background: white; border-radius: 10px; padding: 40px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
            <h1 style="color: #667eea; margin: 0 0 20px 0; font-size: 28px; text-align: center;">
              Welcome to VibeXpert! 🎓
            </h1>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              Hi <strong>${username}</strong>,
            </p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              Congratulations! Your account has been successfully created. 🎉
            </p>
            <div style="background: #f8f9fa; border-left: 4px solid #667eea; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <p style="margin: 0; color: #333; font-size: 14px;">
                <strong>You can now:</strong>
              </p>
              <ul style="color: #666; font-size: 14px; line-height: 1.8; margin: 10px 0;">
                <li>Join your college community</li>
                <li>Connect with fellow students</li>
                <li>Share posts and messages</li>
                <li>Discover campus events</li>
              </ul>
            </div>
            <div style="text-align: center; margin: 30px 0;">
              <a href="http://www.vibexpert.online" 
                 style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                        color: white; text-decoration: none; padding: 12px 30px; border-radius: 25px; 
                        font-weight: bold; font-size: 16px;">
                Get Started
              </a>
            </div>
            <p style="color: #666; font-size: 14px; line-height: 1.6; margin-top: 30px; text-align: center;">
              Best regards,<br>
              <strong style="color: #667eea;">The VibeXpert Team</strong>
            </p>
          </div>
          <p style="color: white; font-size: 12px; text-align: center; margin-top: 20px;">
            © 2025 VibeXpert. All rights reserved.
          </p>
        </div>
      </body>
      </html>
    `;
    
    sendEmail({ to: email, subject, html }).catch(err => {
      console.error('Welcome email failed (non-blocking):', err);
    });

    // Generate token
    const token = signToken(newUser);

    res.status(201).json({
      success: true,
      message: 'Account created successfully! Check your email for a welcome message.',
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        college: newUser.college,
        communityJoined: newUser.community_joined || false
      },
      token
    });

  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const token = signToken(user);

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        college: user.college,
        communityJoined: user.community_joined || false
      },
      token
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// Forgot password
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id, username, email')
      .eq('email', email)
      .single();

    if (userErr || !user) {
      // Don't reveal if email exists
      return res.json({ 
        success: true, 
        message: 'If the email exists, a reset code has been sent.' 
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 1000 * 60 * 15);

    const { error: codeErr } = await supabase
      .from('codes')
      .insert({
        user_id: user.id,
        code,
        type: 'reset',
        expires_at: expires.toISOString(),
        used: false,
        created_at: new Date().toISOString()
      });

    if (codeErr) {
      console.error('Error saving reset code:', codeErr);
      return res.status(500).json({ error: 'Failed to generate reset code' });
    }

    const subject = 'Password Reset Code - VibeXpert';
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 20px;">
          <div style="background: white; border-radius: 10px; padding: 40px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
            <h1 style="color: #667eea; margin: 0 0 20px 0; font-size: 28px; text-align: center;">
              Password Reset Request 🔒
            </h1>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              Hi <strong>${user.username}</strong>,
            </p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              You requested to reset your password. Use the code below to proceed:
            </p>
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                        padding: 30px; text-align: center; font-size: 42px; font-weight: bold; 
                        letter-spacing: 10px; margin: 30px 0; border-radius: 10px; color: white;
                        box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
              ${code}
            </div>
            <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 15px; margin: 20px 0;">
              <p style="margin: 0; color: #856404; font-size: 14px;">
                ⏰ <strong>This code expires in 15 minutes.</strong>
              </p>
            </div>
            <p style="color: #666; font-size: 14px; line-height: 1.6;">
              If you didn't request this password reset, please ignore this email. Your password will remain unchanged.
            </p>
            <p style="color: #666; font-size: 14px; line-height: 1.6; margin-top: 30px; text-align: center;">
              Best regards,<br>
              <strong style="color: #667eea;">The VibeXpert Team</strong>
            </p>
          </div>
          <p style="color: white; font-size: 12px; text-align: center; margin-top: 20px;">
            © 2025 VibeXpert. All rights reserved.
          </p>
        </div>
      </body>
      </html>
    `;

    const result = await sendEmail({ to: email, subject, html });

    res.json({
      success: true,
      message: 'If the email exists, a reset code has been sent.',
      emailSent: result.success
    });

  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process request. Please try again.' });
  }
});

// Verify reset code & reset password
app.post('/api/verify-reset-code', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (userErr || !user) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    const { data: codeRow, error: codeErr } = await supabase
      .from('codes')
      .select('*')
      .eq('user_id', user.id)
      .eq('code', code)
      .eq('type', 'reset')
      .eq('used', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (codeErr) {
      console.error('Error fetching code:', codeErr);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!codeRow) {
      return res.status(400).json({ error: 'Invalid or already used code' });
    }

    if (new Date(codeRow.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
    }

    const pwHash = await bcrypt.hash(newPassword, 10);
    const { error: updateErr } = await supabase
      .from('users')
      .update({ password_hash: pwHash })
      .eq('id', user.id);

    if (updateErr) {
      console.error('Error updating password:', updateErr);
      return res.status(500).json({ error: 'Failed to update password' });
    }

    await supabase
      .from('codes')
      .update({ used: true })
      .eq('id', codeRow.id);

    res.json({
      success: true,
      message: 'Password reset successfully! You can now login with your new password.'
    });

  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password. Please try again.' });
  }
});

// Select college
app.post('/api/select-college', authMiddleware, async (req, res) => {
  try {
    const { college } = req.body;

    if (!college) {
      return res.status(400).json({ error: 'College name is required' });
    }

    if (req.user.community_joined) {
      return res.status(400).json({ error: 'You have already joined a community' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 1000 * 60 * 30);

    const { error: codeErr } = await supabase
      .from('codes')
      .insert({
        user_id: req.user.id,
        code,
        type: 'college',
        meta: { college },
        expires_at: expires.toISOString(),
        used: false,
        created_at: new Date().toISOString()
      });

    if (codeErr) {
      console.error('Error saving college code:', codeErr);
      return res.status(500).json({ error: 'Failed to generate confirmation code' });
    }

    const subject = `Confirm Your College - ${college}`;
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 20px;">
          <div style="background: white; border-radius: 10px; padding: 40px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
            <h1 style="color: #667eea; margin: 0 0 20px 0; font-size: 28px; text-align: center;">
              Confirm Joining ${college} 🎓
            </h1>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              Hi <strong>${req.user.username}</strong>,
            </p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              To confirm joining <strong>${college}</strong>, enter this code:
            </p>
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                        padding: 30px; text-align: center; font-size: 42px; font-weight: bold; 
                        letter-spacing: 10px; margin: 30px 0; border-radius: 10px; color: white;
                        box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
              ${code}
            </div>
            <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 15px; margin: 20px 0;">
              <p style="margin: 0; color: #856404; font-size: 14px;">
                ⏰ <strong>This code expires in 30 minutes.</strong>
              </p>
            </div>
            <p style="color: #666; font-size: 14px; line-height: 1.6; margin-top: 30px; text-align: center;">
              Best regards,<br>
              <strong style="color: #667eea;">The VibeXpert Team</strong>
            </p>
          </div>
          <p style="color: white; font-size: 12px; text-align: center; margin-top: 20px;">
            © 2025 VibeXpert. All rights reserved.
          </p>
        </div>
      </body>
      </html>
    `;

    await sendEmail({ to: req.user.email, subject, html });

    res.json({
      success: true,
      message: 'Confirmation code sent to your email'
    });

  } catch (err) {
    console.error('Select college error:', err);
    res.status(500).json({ error: 'Failed to send confirmation code' });
  }
});

// Verify college code
app.post('/api/verify-college-code', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Verification code is required' });
    }

    const { data: codeRow, error: codeErr } = await supabase
      .from('codes')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('code', code)
      .eq('type', 'college')
      .eq('used', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (codeErr) {
      console.error('Error fetching college code:', codeErr);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!codeRow) {
      return res.status(400).json({ error: 'Invalid or already used code' });
    }

    if (new Date(codeRow.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
    }

    const college = codeRow.meta?.college;
    if (!college) {
      return res.status(500).json({ error: 'Invalid code data' });
    }

    const { error: updateErr } = await supabase
      .from('users')
      .update({
        college,
        community_joined: true
      })
      .eq('id', req.user.id);

    if (updateErr) {
      console.error('Error updating user college:', updateErr);
      return res.status(500).json({ error: 'Failed to join community' });
    }

    await supabase
      .from('codes')
      .update({ used: true })
      .eq('id', codeRow.id);

    res.json({
      success: true,
      message: `Successfully joined ${college}!`,
      college
    });

  } catch (err) {
    console.error('Verify college code error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Get community chat messages
app.get('/api/community/chat', authMiddleware, async (req, res) => {
  try {
    if (!req.user.community_joined) {
      return res.status(403).json({ error: 'You must join a community first' });
    }

    const { data, error } = await supabase
      .from('messages')
      .select('*, users(id, username, profile_pic)')
      .order('timestamp', { ascending: true })
      .limit(500);

    if (error) {
      console.error('Error fetching messages:', error);
      return res.status(500).json({ error: 'Failed to fetch messages' });
    }

    res.json({ 
      success: true,
      messages: data || [] 
    });

  } catch (err) {
    console.error('Community chat error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Post community message
app.post('/api/community/message', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    if (!req.user.community_joined) {
      return res.status(403).json({ error: 'You must join a community first' });
    }

    let imageUrl = null;

    if (req.file) {
      const filename = `chat/${req.user.id}/${Date.now()}_${uuidv4()}`;
      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(filename, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false
        });

      if (error) {
        console.error('Storage upload error:', error);
        return res.status(500).json({ error: 'Failed to upload image' });
      }

      const { data: urlData } = supabase.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(filename);
      
      imageUrl = urlData.publicUrl;
    }

    const { content } = req.body;

    if (!content && !imageUrl) {
      return res.status(400).json({ error: 'Message must have content or image' });
    }

    const { data: message, error: insertErr } = await supabase
      .from('messages')
      .insert({
        sender_id: req.user.id,
        content: content || null,
        image_url: imageUrl,
        timestamp: new Date().toISOString()
      })
      .select('*, users(id, username, profile_pic)')
      .single();

    if (insertErr) {
      console.error('Error inserting message:', insertErr);
      return res.status(500).json({ error: 'Failed to send message' });
    }

    io.emit('new_message', message);

    res.json({
      success: true,
      message
    });

  } catch (err) {
    console.error('Post message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Upload post
app.post('/api/post/upload', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Image is required' });
    }

    const { caption, postedTo } = req.body;

    if (!['profile', 'community'].includes(postedTo)) {
      return res.status(400).json({ error: 'Invalid postedTo value' });
    }

    const filename = `posts/${req.user.id}/${Date.now()}_${uuidv4()}`;
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (error) {
      console.error('Storage upload error:', error);
      return res.status(500).json({ error: 'Failed to upload image' });
    }

    const { data: urlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(filename);

    const { data: post, error: postErr } = await supabase
      .from('posts')
      .insert({
        user_id: req.user.id,
        image_url: urlData.publicUrl,
        caption: caption || '',
        posted_to: postedTo,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (postErr) {
      console.error('Error inserting post:', postErr);
      return res.status(500).json({ error: 'Failed to create post' });
    }

    res.json({
      success: true,
      post
    });

  } catch (err) {
    console.error('Upload post error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Get user profile
app.get('/api/user/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.params.id;

    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email, profile_pic, liked_profiles, college, community_joined')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      user
    });

  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Like a user profile
app.post('/api/user/:id/like', authMiddleware, async (req, res) => {
  try {
    const targetId = req.params.id;

    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'Cannot like your own profile' });
    }

    const liked = req.user.liked_profiles || [];

    if (liked.includes(targetId)) {
      return res.json({
        success: true,
        message: 'Already liked'
      });
    }

    liked.push(targetId);

    const { error } = await supabase
      .from('users')
      .update({ liked_profiles: liked })
      .eq('id', req.user.id);

    if (error) {
      console.error('Error updating likes:', error);
      return res.status(500).json({ error: 'Failed to like profile' });
    }

    res.json({
      success: true,
      message: 'Profile liked'
    });

  } catch (err) {
    console.error('Like user error:', err);
    res.status(500).json({ error: 'Failed to like profile' });
  }
});

// Delete account
app.delete('/api/user/delete', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', req.user.id);

    if (error) {
      console.error('Error deleting user:', error);
      return res.status(500).json({ error: 'Failed to delete account' });
    }

    res.json({
      success: true,
      message: 'Account deleted successfully'
    });

  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
  console.log('✅ Socket connected:', socket.id);

  socket.on('send_message', async (payload) => {
    try {
      const { token, content } = payload;

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
        return socket.emit('error', { error: 'Not authorized' });
      }

      const { data: message } = await supabase
        .from('messages')
        .insert({
          sender_id: user.id,
          content: content || null,
          timestamp: new Date().toISOString()
        })
        .select('*, users(id, username, profile_pic)')
        .single();

      io.emit('new_message', message);

    } catch (err) {
      console.error('Socket send_message error:', err);
      socket.emit('error', { error: 'Failed to send message' });
    }
  });

  socket.on('react', async ({ token, messageId, type }) => {
    try {
      if (!token) return socket.emit('error', { error: 'Token required' });

      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;

      const { data: msg, error } = await supabase
        .from('messages')
        .select('*')
        .eq('id', messageId)
        .single();

      if (error || !msg) return;

      const reactions = Array.isArray(msg.reactions) ? msg.reactions : [];
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

    } catch (err) {
      console.error('Socket react error:', err);
      socket.emit('error', { error: 'Failed to react' });
    }
  });

  socket.on('disconnect', () => {
    console.log('❌ Socket disconnected:', socket.id);
  });
});

// Error handling middleware
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    path: req.path 
  });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
const PORT = process.env.PORT || 4000;

server.listen(PORT, "0.0.0.0", () => {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 VibeXpert Server Started Successfully!');
  console.log('='.repeat(70));
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log(`🔒 JWT Secret: ${JWT_SECRET ? '✅ Configured' : '❌ Missing'}`);
  console.log(`💾 Supabase: ${SUPABASE_URL ? '✅ Connected' : '❌ Not configured'}`);
  console.log(`📧 Email (SMTP): ${emailTransporter ? '✅ Ready' : '⚠️  Not configured'}`);
  if (SMTP_USER) {
    console.log(`   ├─ SMTP Host: ${SMTP_HOST}:${SMTP_PORT}`);
    console.log(`   ├─ SMTP User: ${SMTP_USER.substring(0, 10)}***`);
    console.log(`   └─ From Email: ${SMTP_FROM_EMAIL}`);
  }
  console.log(`📦 Storage Bucket: ${STORAGE_BUCKET}`);
  console.log(`🔌 WebSocket: ✅ Active`);
  console.log('='.repeat(70));
  console.log(`\n✅ API ready at: https://vibexpert-backend-main.onrender.com`);
  console.log(`🔍 Health: https://vibexpert-backend-main.onrender.com/api/health`);
  console.log(`🌐 Frontend: http://www.vibexpert.online\n`);
  console.log('='.repeat(70) + '\n');
});
