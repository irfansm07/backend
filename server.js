require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const socketIO = require('socket.io');
const axios = require('axios');

// Initialize Express
const app = express();
const server = http.createServer(app);

// Initialize Socket.io with CORS
const io = socketIO(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'https://www.vibexpert.online',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Middleware - Enhanced CORS
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://www.vibexpert.online',
  'http://www.vibexpert.online',
  'https://irfansm07.github.io'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.some(allowed => origin && origin.startsWith(allowed))) {
      callback(null, true);
    } else {
      console.log('❌ CORS blocked origin:', origin);
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Nodemailer with Brevo
const transporter = nodemailer.createTransport({
  host: 'smtp-relay.sendinblue.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000
});

// Verify SMTP connection on startup
transporter.verify(function (error, success) {
  if (error) {
    console.error('❌ SMTP Configuration Error:', error.message);
    console.log('⚠️  Email sending will use Brevo API as fallback');
  } else {
    console.log('✅ SMTP Server is ready to send emails');
  }
});

// Multer configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE_BYTES) || 5242880 }
});

// Helper Functions
const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

// Send email with fallback to Brevo API
const sendEmail = async (to, subject, html) => {
  try {
    console.log(`📧 Attempting to send email to: ${to}`);
    
    // Try SMTP first
    try {
      const info = await transporter.sendMail({
        from: `${process.env.BREVO_FROM_NAME} <${process.env.BREVO_FROM_EMAIL}>`,
        to,
        subject,
        html
      });
      console.log(`✅ Email sent via SMTP: ${info.messageId}`);
      return true;
    } catch (smtpError) {
      console.log('⚠️  SMTP failed, trying Brevo API...', smtpError.message);
      
      // Fallback to Brevo API
      const response = await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
          sender: {
            name: process.env.BREVO_FROM_NAME,
            email: process.env.BREVO_FROM_EMAIL
          },
          to: [{ email: to }],
          subject: subject,
          htmlContent: html
        },
        {
          headers: {
            'api-key': process.env.BREVO_API_KEY,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      
      console.log(`✅ Email sent via Brevo API: ${response.data.messageId}`);
      return true;
    }
  } catch (error) {
    console.error('❌ All email methods failed:', error.message);
    return false;
  }
};

// Middleware: Verify JWT Token
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(403).json({ error: 'Invalid token' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// ============================================
// USER AUTHENTICATION ROUTES
// ============================================

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if user exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('email')
      .eq('email', email)
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const { data: newUser, error } = await supabase
      .from('users')
      .insert([{
        username,
        email,
        password_hash: passwordHash
      }])
      .select()
      .single();

    if (error) {
      console.error('Database error:', error);
      throw new Error('Failed to create account');
    }

    // Send welcome email (non-blocking)
    sendEmail(
      email,
      '🎉 Welcome to VibeXpert!',
      `
       <div style="font-family: 'Helvetica Neue', Arial, sans-serif; background: linear-gradient(135deg, #6366F1, #8B5CF6); padding: 40px 0; color: #111827;">
    <div style="max-width: 600px; background: #ffffff; border-radius: 16px; padding: 40px; margin: 0 auto; box-shadow: 0 8px 20px rgba(79,70,229,0.2);">
      
      <div style="text-align: center; margin-bottom: 24px;">
        <img src="https://img.icons8.com/color/96/000000/confetti.png" alt="🎉" style="width: 80px; height: 80px;">
        <h1 style="color: #4F46E5; font-size: 28px; margin-top: 16px;">Welcome to <span style="color:#8B5CF6;">VibeXpert</span>, ${username}! 🎊</h1>
      </div>

      <p style="font-size: 17px; color: #374151; text-align: center; line-height: 1.6;">
        You’ve officially joined <strong>the ultimate college community</strong> — where connection, fun, and discovery thrive.
      </p>

      <div style="margin-top: 30px; padding: 20px; background: #F9FAFB; border-left: 5px solid #4F46E5; border-radius: 12px;">
        <h2 style="color: #111827; font-size: 18px;">Next Steps ✨</h2>
        <ol style="font-size: 16px; color: #4B5563; line-height: 1.8; margin-left: 20px;">
          <li>Log in to your account</li>
          <li>Select your college</li>
          <li>Start connecting and vibing with your community! 💬</li>
        </ol>
      </div>

      <div style="text-align: center; margin-top: 40px;">
        <a href="https://vibexpert.com/login" 
           style="display: inline-block; background: linear-gradient(90deg, #4F46E5, #8B5CF6); color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 50px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 10px rgba(79,70,229,0.4); transition: all 0.3s ease;">
          🚀 Get Started
        </a>
      </div>

      <p style="text-align: center; color: #6B7280; font-size: 14px; margin-top: 40px;">
        Thanks for joining the vibe — let’s make college unforgettable! 💜<br>
        — The <strong>VibeXpert</strong> Team
      </p>
    </div>
  </div>
      `
    ).catch(err => console.error('Email send failed:', err));

    res.status(201).json({
      message: 'Account created successfully! Please log in.',
      userId: newUser.id
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Get user
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        college: user.college,
        communityJoined: user.community_joined,
        profilePic: user.profile_pic
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Forgot Password - Send Reset Code
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    // Check if user exists
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email')
      .eq('email', email)
      .maybeSingle();

    if (error || !user) {
      return res.json({ 
        success: true,
        message: 'If this email exists, you will receive a reset code.' 
      });
    }

    // Generate 6-digit code
    const code = generateCode();
    const expiresAt = new Date(Date.now() + parseInt(process.env.RESET_CODE_TTL_MIN || 15) * 60 * 1000);

    console.log(`🔑 Generated reset code for ${email}: ${code}`);

    // Store code
    const { error: codeError } = await supabase.from('codes').insert([{
      user_id: user.id,
      code,
      type: 'reset',
      expires_at: expiresAt.toISOString()
    }]);

    if (codeError) {
      console.error('❌ Error storing code:', codeError);
      throw new Error('Failed to generate reset code');
    }

    // Send email (non-blocking)
    sendEmail(
      email,
      '🔐 Password Reset Code - VibeXpert',
      `
        <div style="font-family: 'Helvetica Neue', Arial, sans-serif; background: linear-gradient(135deg, #4F46E5, #6366F1); padding: 40px 0;">
    <div style="max-width: 600px; background: #ffffff; border-radius: 16px; padding: 40px; margin: 0 auto; box-shadow: 0 8px 24px rgba(79,70,229,0.25);">
      
      <div style="text-align: center; margin-bottom: 24px;">
        <img src="https://img.icons8.com/fluency/96/lock--v1.png" alt="Lock Icon" style="width: 70px; height: 70px;">
        <h1 style="color: #4F46E5; font-size: 26px; margin-top: 12px;">Password Reset Request</h1>
      </div>

      <p style="font-size: 16px; color: #374151; text-align: center;">
        Hi <strong>${user.username}</strong>,
      </p>

      <p style="font-size: 16px; color: #4B5563; line-height: 1.6; text-align: center;">
        We received a request to reset your password for your VibeXpert account.<br>
        Use the code below to proceed securely:
      </p>

      <div style="background: linear-gradient(90deg, #EEF2FF, #E0E7FF); padding: 24px; border-radius: 12px; text-align: center; margin: 28px 0; border: 2px dashed #4F46E5;">
        <h2 style="color: #111827; font-size: 36px; letter-spacing: 6px; margin: 0;">${code}</h2>
      </div>

      <p style="font-size: 15px; color: #6B7280; text-align: center;">
        ⏰ This code expires in <strong>${process.env.RESET_CODE_TTL_MIN || 15} minutes</strong>.
      </p>

      <p style="font-size: 15px; color: #6B7280; text-align: center;">
        If you didn’t request this password reset, you can safely ignore this email.
      </p>

      <div style="text-align: center; margin-top: 32px;">
        <a href="https://vibexpert.com/reset-password"
           style="display: inline-block; background: linear-gradient(90deg, #4F46E5, #8B5CF6); color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 50px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 12px rgba(79,70,229,0.4); transition: all 0.3s ease;">
          🔄 Reset Password
        </a>
      </div>

      <p style="text-align: center; color: #9CA3AF; font-size: 13px; margin-top: 36px;">
        Stay secure,<br>
        <strong>The VibeXpert Security Team</strong> 🔐
      </p>

    </div>
  </div>
      `
    ).then(sent => {
      if(sent) console.log(`✅ Reset email sent to ${email}`);
    }).catch(err => console.error('Email send failed:', err));

    res.json({ 
      success: true,
      message: 'Reset code sent to your email' 
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to send reset code' });
  }
});

// Verify Reset Code
app.post('/api/verify-reset-code', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code required' });
    }

    // Get user
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    // Verify code
    const { data: codeData } = await supabase
      .from('codes')
      .select('*')
      .eq('user_id', user.id)
      .eq('code', code)
      .eq('type', 'reset')
      .gte('expires_at', new Date().toISOString())
      .maybeSingle();

    if (!codeData) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    res.json({ success: true, message: 'Code verified' });
  } catch (error) {
    console.error('Verify code error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Reset Password
app.post('/api/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'All fields required' });
    }

    // Get user
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    // Verify code
    const { data: codeData } = await supabase
      .from('codes')
      .select('*')
      .eq('user_id', user.id)
      .eq('code', code)
      .eq('type', 'reset')
      .gte('expires_at', new Date().toISOString())
      .maybeSingle();

    if (!codeData) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    const { error: updateError } = await supabase
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('id', user.id);

    if (updateError) {
      throw new Error('Failed to update password');
    }

    // Delete used code
    await supabase
      .from('codes')
      .delete()
      .eq('id', codeData.id);

    res.json({ success: true, message: 'Password reset successful' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'VibeXpert Backend'
  });
});

// Root route
app.get('/', (req, res) => {
  res.json({ 
    message: 'VibeXpert API is running',
    version: '1.0.0'
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Email service: ${process.env.BREVO_FROM_EMAIL}`);
  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL}`);
});

