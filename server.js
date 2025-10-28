// VIBEXPERT - ENHANCED VERSION WITH ALL FEATURES - UPDATED

const API_URL = 'https://vibexpert-backend-main.onrender.com';

let currentUser = null;
let currentType = null;
let currentPage = 1;
const ITEMS_PER_PAGE = 10;
let currentVerifyCollege = null;
let allColleges = [];
let socket = null;
let selectedFiles = [];
let previewUrls = [];
let editingMessageId = null;
let editTimeout = null;
let selectedMusic = null;
let selectedStickers = [];
let cropper = null;

// Enhanced music library with actual audio files
const musicLibrary = [
  {
    id: 1,
    name: "Chill Vibes",
    artist: "LoFi Beats",
    duration: "2:30",
    url: "https://assets.mixkit.co/music/preview/mixkit-chill-vibes-239.mp3",
    emoji: "🎧"
  },
  {
    id: 2,
    name: "Upbeat Energy",
    artist: "Electronic Pop",
    duration: "3:15",
    url: "https://assets.mixkit.co/music/preview/mixkit-upbeat-energy-225.mp3",
    emoji: "⚡"
  },
  {
    id: 3,
    name: "Dreamy Piano",
    artist: "Classical",
    duration: "2:45",
    url: "https://assets.mixkit.co/music/preview/mixkit-dreamy-piano-1171.mp3",
    emoji: "🎹"
  },
  {
    id: 4,
    name: "Summer Vibes",
    artist: "Tropical",
    duration: "3:30",
    url: "https://assets.mixkit.co/music/preview/mixkit-summer-vibes-129.mp3",
    emoji: "🏖️"
  },
  {
    id: 5,
    name: "Happy Day",
    artist: "Pop Rock",
    duration: "2:50",
    url: "https://assets.mixkit.co/music/preview/mixkit-happy-day-583.mp3",
    emoji: "😊"
  },
  {
    id: 6,
    name: "Relaxing Guitar",
    artist: "Acoustic",
    duration: "3:10",
    url: "https://assets.mixkit.co/music/preview/mixkit-relaxing-guitar-243.mp3",
    emoji: "🎸"
  }
];

// Enhanced sticker library with categories
const stickerLibrary = {
  emotions: [
    { id: 'happy', emoji: '😊', name: 'Happy' },
    { id: 'laugh', emoji: '😂', name: 'Laugh' },
    { id: 'love', emoji: '❤️', name: 'Love' },
    { id: 'cool', emoji: '😎', name: 'Cool' },
    { id: 'fire', emoji: '🔥', name: 'Fire' },
    { id: 'star', emoji: '⭐', name: 'Star' }
  ],
  animals: [
    { id: 'cat', emoji: '🐱', name: 'Cat' },
    { id: 'dog', emoji: '🐶', name: 'Dog' },
    { id: 'panda', emoji: '🐼', name: 'Panda' },
    { id: 'unicorn', emoji: '🦄', name: 'Unicorn' },
    { id: 'dragon', emoji: '🐉', name: 'Dragon' },
    { id: 'butterfly', emoji: '🦋', name: 'Butterfly' }
  ],
  objects: [
    { id: 'balloon', emoji: '🎈', name: 'Balloon' },
    { id: 'gift', emoji: '🎁', name: 'Gift' },
    { id: 'camera', emoji: '📷', name: 'Camera' },
    { id: 'music', emoji: '🎵', name: 'Music' },
    { id: 'book', emoji: '📚', name: 'Book' },
    { id: 'computer', emoji: '💻', name: 'Computer' }
  ],
  nature: [
    { id: 'sun', emoji: '☀️', name: 'Sun' },
    { id: 'moon', emoji: '🌙', name: 'Moon' },
    { id: 'tree', emoji: '🌳', name: 'Tree' },
    { id: 'flower', emoji: '🌸', name: 'Flower' },
    { id: 'rainbow', emoji: '🌈', name: 'Rainbow' },
    { id: 'wave', emoji: '🌊', name: 'Wave' }
  ],
  food: [
    { id: 'pizza', emoji: '🍕', name: 'Pizza' },
    { id: 'burger', emoji: '🍔', name: 'Burger' },
    { id: 'icecream', emoji: '🍦', name: 'Ice Cream' },
    { id: 'coffee', emoji: '☕', name: 'Coffee' },
    { id: 'cake', emoji: '🍰', name: 'Cake' },
    { id: 'drink', emoji: '🥤', name: 'Drink' }
  ],
  activities: [
    { id: 'sports', emoji: '⚽', name: 'Sports' },
    { id: 'game', emoji: '🎮', name: 'Game' },
    { id: 'music', emoji: '🎵', name: 'Music' },
    { id: 'art', emoji: '🎨', name: 'Art' },
    { id: 'movie', emoji: '🎬', name: 'Movie' },
    { id: 'travel', emoji: '✈️', name: 'Travel' }
  ]
};

const colleges = {
  nit: [
    {name: 'NIT Bhopal', email: '@stu.manit.ac.in', location: 'Bhopal'},
    {name: 'NIT Rourkela', email: '@nitrkl.ac.in', location: 'Rourkela'},
    {name: 'NIT Warangal', email: '@nitw.ac.in', location: 'Warangal'},
    {name: 'NIT Trichy', email: '@nitt.edu', location: 'Trichy'},
    {name: 'NIT Surathkal', email: '@nitk.edu.in', location: 'Surathkal'},
  ],
  iit: [
    {name: 'IIT Delhi', email: '@iitd.ac.in', location: 'New Delhi'},
    {name: 'IIT Bombay', email: '@iitb.ac.in', location: 'Mumbai'},
    {name: 'IIT Madras', email: '@iitm.ac.in', location: 'Chennai'},
    {name: 'IIT Kharagpur', email: '@kgp.iitkgp.ac.in', location: 'Kharagpur'},
    {name: 'IIT Kanpur', email: '@iitk.ac.in', location: 'Kanpur'},
  ],
  vit: [
    {name: 'VIT Bhopal', email: '@vitbhopal.ac.in', location: 'Bhopal'},
    {name: 'VIT Vellore', email: '@vit.ac.in', location: 'Vellore'},
    {name: 'VIT Chennai', email: '@vit.ac.in', location: 'Chennai'},
  ],
  other: [
    {name: 'Delhi University', email: '@du.ac.in', location: 'New Delhi'},
    {name: 'Mumbai University', email: '@mu.ac.in', location: 'Mumbai'},
    {name: 'BITS Pilani', email: '@pilani.bits-pilani.ac.in', location: 'Pilani'},
  ]
};

function getToken() {
  return localStorage.getItem('authToken');
}

async function apiCall(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {}
  };
  
  const token = getToken();
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }
  
  if (body && !(body instanceof FormData)) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    options.body = body;
  }
  
  try {
    const response = await fetch(`${API_URL}${endpoint}`, options);
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'Request failed');
    }
    
    return data;
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
}

// INIT - Enhanced with music and sticker event listeners
document.addEventListener('DOMContentLoaded', function() {
  checkUser();
  showLoginForm();
  updateLiveStats();
  setInterval(updateLiveStats, 5000);
  initializeSearchBar();
  loadTrending();
  
  // Initialize post destination
  selectedPostDestination = 'profile';
  
  // Add event listeners for music and sticker buttons
  setTimeout(() => {
    const addMusicBtn = document.getElementById('addMusicBtn');
    const addStickerBtn = document.getElementById('addStickerBtn');
    
    if (addMusicBtn) {
      addMusicBtn.addEventListener('click', showMusicSelector);
    }
    
    if (addStickerBtn) {
      addStickerBtn.addEventListener('click', showStickerSelector);
    }
  }, 1000);
});

function checkUser() {
  const token = getToken();
  const saved = localStorage.getItem('user');
  
  if(token && saved) {
    currentUser = JSON.parse(saved);
    document.getElementById('loginPage').style.display = 'none';
    document.getElementById('mainPage').style.display = 'block';
    document.getElementById('userName').textContent = 'Hi, ' + currentUser.username;
    
    if (currentUser.college) {
      updateLiveNotif(`Connected to ${currentUser.college}`);
      initializeSocket();
    }
  }
}

function initializeSocket() {
  if (socket) return;
  
  socket = io(API_URL);
  
  socket.on('connect', () => {
    console.log('Socket connected');
    if (currentUser?.college) {
      socket.emit('join_college', currentUser.college);
    }
    socket.emit('user_online', currentUser.id);
  });
  
  socket.on('new_message', (message) => {
    appendMessageToChat(message);
  });
  
  socket.on('message_updated', (message) => {
    updateMessageInChat(message);
  });
  
  socket.on('message_deleted', ({ id }) => {
    removeMessageFromChat(id);
  });
  
  socket.on('online_count', (count) => {
    updateOnlineCount(count);
  });
}

function showLoginForm() {
  document.getElementById('loginForm').style.display = 'block';
  document.getElementById('forgotPasswordForm').style.display = 'none';
  document.getElementById('signupForm').style.display = 'none';
}

async function login(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  
  if(!email || !password) {
    msg('Fill all fields', 'error');
    return;
  }
  
  try {
    msg('Logging in...', 'success');
    
    const data = await apiCall('/api/login', 'POST', { email, password });
    
    localStorage.setItem('authToken', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    currentUser = data.user;
    
    msg('✅ Login successful!', 'success');
    
    setTimeout(() => {
      document.getElementById('loginPage').style.display = 'none';
      document.getElementById('mainPage').style.display = 'block';
      document.getElementById('userName').textContent = 'Hi, ' + currentUser.username;
      document.getElementById('loginForm').reset();
      loadPosts();
      if (currentUser.college) {
        initializeSocket();
      }
    }, 800);
  } catch (error) {
    msg('❌ Login failed: ' + error.message, 'error');
  }
}

async function signup(e) {
  e.preventDefault();
  const username = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const registrationNumber = document.getElementById('signupReg').value.trim();
  const password = document.getElementById('signupPass').value;
  const confirm = document.getElementById('signupConfirm').value;
  
  if(!username || !email || !registrationNumber || !password || !confirm) {
    msg('Fill all fields', 'error');
    return;
  }
  
  if(password !== confirm) {
    msg('Passwords don\'t match', 'error');
    return;
  }
  
  try {
    msg('Creating account...', 'success');
    
    await apiCall('/api/register', 'POST', { username, email, password, registrationNumber });
    
    msg('🎉 Account created! Check your email', 'success');
    
    document.getElementById('signupForm').reset();
    
    setTimeout(() => {
      goLogin(null);
    }, 2000);
  } catch (error) {
    msg('❌ ' + error.message, 'error');
  }
}

function goForgotPassword(e) {
  e.preventDefault();
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('signupForm').style.display = 'none';
  document.getElementById('forgotPasswordForm').style.display = 'block';
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const email = document.getElementById('resetEmail').value.trim();
  
  if(!email) {
    msg('Enter your email', 'error');
    return;
  }
  
  try {
    await apiCall('/api/forgot-password', 'POST', { email });
    msg('✅ Check your email for reset code', 'success');
  } catch (error) {
    msg('❌ ' + error.message, 'error');
  }
}

function goSignup(e) {
  e.preventDefault();
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('forgotPasswordForm').style.display = 'none';
  document.getElementById('signupForm').style.display = 'block';
}

function goLogin(e) {
  if(e) e.preventDefault();
  document.getElementById('signupForm').style.display = 'none';
  document.getElementById('forgotPasswordForm').style.display = 'none';
  document.getElementById('loginForm').style.display = 'block';
}

function logout() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  currentUser = null;
  localStorage.removeItem('authToken');
  localStorage.removeItem('user');
  document.getElementById('mainPage').style.display = 'none';
  document.getElementById('loginPage').style.display = 'flex';
  msg('👋 Logged out', 'success');
  showLoginForm();
}

function showPage(name, e) {
  if(e) e.preventDefault();
  
  document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
  const targetPage = document.getElementById(name);
  if(targetPage) targetPage.style.display = 'block';
  
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  if(e && e.target) e.target.classList.add('active');
  
  if(name === 'posts') {
    loadPosts();
  } else if(name === 'communities') {
    loadCommunities();
  } else if(name === 'badges') {
    loadBadgesPage();
  }
  
  document.getElementById('hamburgerMenu').style.display = 'none';
  
  window.scrollTo(0, 0);
}

function goHome() {
  showPage('home');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.querySelector('.nav-link[onclick*="home"]')?.classList.add('active');
}

function selectUniversity(type) {
  currentType = type;
  currentPage = 1;
  allColleges = colleges[type];
  
  const titles = {
    nit: 'National Institutes of Technology',
    iit: 'Indian Institutes of Technology',
    vit: 'VIT Colleges',
    other: 'Other Universities'
  };
  
  document.getElementById('collegeTitle').textContent = titles[type];
  document.getElementById('home').style.display = 'none';
  document.getElementById('collegeList').style.display = 'block';
  
  showColleges();
}

function showColleges() {
  const list = allColleges;
  const start = (currentPage - 1) * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;
  const page = list.slice(start, end);
  
  let html = '';
  page.forEach(c => {
    const isConnected = currentUser && currentUser.college === c.name;
    html += `
      <div class="college-item">
        <h3>${c.name}</h3>
        <p>${c.location}</p>
        ${isConnected 
          ? '<button class="verified" disabled>✓ Connected</button>'
          : `<button onclick="openVerify('${c.name}', '${c.email}')">Connect</button>`
        }
      </div>
    `;
  });
  
  document.getElementById('collegeContainer').innerHTML = html;
}

function searchColleges() {
  const search = document.getElementById('searchCollege').value.toLowerCase();
  const filtered = colleges[currentType].filter(c => 
    c.name.toLowerCase().includes(search) || c.location.toLowerCase().includes(search)
  );
  allColleges = filtered;
  currentPage = 1;
  showColleges();
}

function backToUniversities() {
  document.getElementById('collegeList').style.display = 'none';
  document.getElementById('home').style.display = 'block';
}

function openVerify(name, emailDomain) {
  if (currentUser && currentUser.college) {
    msg('⚠️ You are already connected to ' + currentUser.college, 'error');
    return;
  }
  
  currentVerifyCollege = {name, emailDomain};
  
  const modalHtml = `
    <div class="modal-box">
      <span class="close" onclick="closeModal('verifyModal')">&times;</span>
      <h2>Verify Your College</h2>
      <p>Enter your college email to verify</p>
      <p style="color:#888; font-size:13px;">Email must end with: ${emailDomain}</p>
      <input type="email" id="verifyEmail" placeholder="your.email${emailDomain}">
      <button onclick="requestVerificationCode()">Send Verification Code</button>
      <div id="codeSection" style="display:none; margin-top:20px;">
        <input type="text" id="verifyCode" placeholder="Enter 6-digit code" maxlength="6">
        <button onclick="verifyCollegeCode()">Verify Code</button>
      </div>
    </div>
  `;
  
  document.getElementById('verifyModal').innerHTML = modalHtml;
  document.getElementById('verifyModal').style.display = 'flex';
}

async function requestVerificationCode() {
  const email = document.getElementById('verifyEmail').value.trim();
  
  if (!email) {
    msg('⚠️ Enter your email', 'error');
    return;
  }
  
  if (!email.endsWith(currentVerifyCollege.emailDomain)) {
    msg('⚠️ Email must end with ' + currentVerifyCollege.emailDomain, 'error');
    return;
  }
  
  try {
    msg('📧 Sending verification code...', 'success');
    
    await apiCall('/api/college/request-verification', 'POST', {
      collegeName: currentVerifyCollege.name,
      collegeEmail: email
    });
    
    msg('✅ Code sent to ' + email, 'success');
    document.getElementById('codeSection').style.display = 'block';
  } catch (error) {
    msg('❌ ' + error.message, 'error');
  }
}

async function verifyCollegeCode() {
  const code = document.getElementById('verifyCode').value.trim();
  
  if (!code || code.length !== 6) {
    msg('⚠️ Enter 6-digit code', 'error');
    return;
  }
  
  try {
    msg('🔍 Verifying...', 'success');
    
    const data = await apiCall('/api/college/verify', 'POST', { code });
    
    msg('🎉 ' + data.message, 'success');
    
    currentUser.college = data.college;
    currentUser.communityJoined = true;
    currentUser.badges = data.badges;
    localStorage.setItem('user', JSON.stringify(currentUser));
    
    closeModal('verifyModal');
    
    initializeSocket();
    
    setTimeout(() => {
      showPage('communities');
      updateLiveNotif('Connected to ' + data.college);
    }, 1500);
  } catch (error) {
    msg('❌ ' + error.message, 'error');
  }
}

// ENHANCED POSTS WITH MUSIC AND STICKERS
let selectedPostDestination = 'profile';

async function createPost() {
  const text = document.getElementById('postText').value.trim();
  
  if(!text && selectedFiles.length === 0 && !selectedMusic && selectedStickers.length === 0) {
    msg('⚠️ Add text, photos, music or stickers', 'error');
    return;
  }
  
  if(!currentUser) {
    msg('❌ Please login', 'error');
    return;
  }
  
  try {
    msg('📤 Posting...', 'success');
    
    const formData = new FormData();
    formData.append('content', text);
    formData.append('postTo', selectedPostDestination);
    
    // Add music data if selected
    if (selectedMusic) {
      formData.append('music', JSON.stringify(selectedMusic));
    }
    
    // Add stickers data if selected
    if (selectedStickers.length > 0) {
      formData.append('stickers', JSON.stringify(selectedStickers));
    }
    
    selectedFiles.forEach(file => {
      formData.append('media', file);
    });
    
    const data = await apiCall('/api/posts', 'POST', formData);
    
    if(data.success) {
      msg('🎉 Posted!', 'success');
      
      if (data.badges && data.badges.length > currentUser.badges?.length) {
        currentUser.badges = data.badges;
        localStorage.setItem('user', JSON.stringify(currentUser));
        msg('🏆 New badge unlocked!', 'success');
      }
      
      document.getElementById('postText').value = '';
      clearSelectedFiles();
      clearSelectedMusic();
      clearSelectedStickers();
      
      loadPosts();
    }
  } catch (error) {
    msg('❌ Failed: ' + error.message, 'error');
  }
}

async function loadPosts() {
  const feedEl = document.getElementById('postsFeed');
  if(!feedEl) return;
  
  try {
    feedEl.innerHTML = '<div style="text-align:center; padding:20px; color:#888;">Loading posts...</div>';
    
    const data = await apiCall('/api/posts?type=my', 'GET');
    
    if(!data.posts || data.posts.length === 0) {
      feedEl.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">No posts yet. Be the first to post! 📝</div>';
      return;
    }
    
    let html = '';
    data.posts.forEach(post => {
      const author = post.users?.username || 'User';
      const authorId = post.users?.id || '';
      const content = post.content || '';
      const media = post.media || [];
      const time = new Date(post.created_at || post.timestamp).toLocaleString();
      const isOwn = currentUser && authorId === currentUser.id;
      const postedTo = post.posted_to === 'community' ? '🌐 Community' : '👤 Profile';
      const music = post.music || null;
      const stickers = post.stickers || [];
      
      html += `
        <div class="enhanced-post">
          <div class="enhanced-post-header">
            <div class="enhanced-user-info">
              <div class="enhanced-user-avatar">
                ${post.users?.profile_pic ? `<img src="${post.users.profile_pic}" class="enhanced-user-avatar">` : '👤'}
              </div>
              <div class="enhanced-user-details">
                <div class="enhanced-username">@${author}</div>
                <div class="enhanced-post-meta">
                  <span>${time}</span>
                  <span>•</span>
                  <span>${postedTo}</span>
                </div>
              </div>
            </div>
            ${isOwn ? `<button class="post-delete-btn" onclick="deletePost('${post.id}')">🗑️ Delete</button>` : ''}
          </div>
          
          <div class="enhanced-post-content">
            ${content ? `<div class="enhanced-post-text">${content}</div>` : ''}
            
            ${stickers.length > 0 ? `
              <div class="post-stickers-container">
                ${stickers.map(sticker => `
                  <span class="post-sticker">${sticker.emoji || sticker}</span>
                `).join('')}
              </div>
            ` : ''}
            
            ${music ? `
              <div class="post-music-container">
                <div class="music-player">
                  <div class="music-info">
                    <div class="music-icon">${music.emoji || '🎵'}</div>
                    <div class="music-details">
                      <div class="music-name">${music.name}</div>
                      <div class="music-duration">${music.artist} • ${music.duration}</div>
                    </div>
                  </div>
                  <audio controls class="post-audio-player">
                    <source src="${music.url}" type="audio/mpeg">
                    Your browser does not support the audio element.
                  </audio>
                </div>
              </div>
            ` : ''}
            
            ${media.length > 0 ? `
              <div class="enhanced-post-media">
                ${media.map(m => 
                  m.type === 'image' 
                    ? `<div class="enhanced-media-item"><img src="${m.url}" alt="Post image"></div>` 
                    : `<div class="enhanced-media-item"><video src="${m.url}" controls></video></div>`
                ).join('')}
              </div>
            ` : ''}
          </div>
          
          <div class="enhanced-post-footer">
            <div class="enhanced-post-stats">
              <span>❤️ 0</span>
              <span>💬 0</span>
              <span>🔄 0</span>
            </div>
            <div class="enhanced-post-engagement">
              <button class="engagement-btn">❤️ Like</button>
              <button class="engagement-btn">💬 Comment</button>
              <button class="engagement-btn">🔄 Share</button>
            </div>
          </div>
        </div>
      `;
    });
    
    feedEl.innerHTML = html;
  } catch (error) {
    console.error('Load posts error:', error);
    feedEl.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">Failed to load posts</div>';
  }
}

async function deletePost(postId) {
  if (!confirm('Delete this post?')) return;
  
  try {
    await apiCall(`/api/posts/${postId}`, 'DELETE');
    msg('🗑️ Post deleted', 'success');
    loadPosts();
  } catch (error) {
    msg('❌ Failed to delete', 'error');
  }
}

// ENHANCED MUSIC SELECTOR
function showMusicSelector() {
  const modal = document.getElementById('musicSelectorModal');
  const selector = document.getElementById('musicSelector');
  
  if (!modal || !selector) {
    console.error('Music selector elements not found');
    return;
  }
  
  let html = '<div class="music-selector">';
  
  musicLibrary.forEach(song => {
    const isSelected = selectedMusic && selectedMusic.id === song.id;
    html += `
      <div class="song-item ${isSelected ? 'selected' : ''}" onclick="selectMusic(${song.id})">
        <div class="song-info">
          <div class="song-name">${song.emoji} ${song.name}</div>
          <div class="song-duration">${song.artist} • ${song.duration}</div>
        </div>
        <div class="song-preview">
          <button class="play-btn" onclick="event.stopPropagation(); previewMusic('${song.url}')">▶️</button>
        </div>
      </div>
    `;
  });
  
  html += '</div>';
  selector.innerHTML = html;
  modal.style.display = 'flex';
}

function selectMusic(songId) {
  const song = musicLibrary.find(s => s.id === songId);
  if (!song) return;
  
  selectedMusic = song;
  updateSelectedAssets();
  closeModal('musicSelectorModal');
  msg(`🎵 Added "${song.name}" to your post`, 'success');
}

function previewMusic(url) {
  // Stop any currently playing audio
  document.querySelectorAll('audio').forEach(audio => {
    audio.pause();
    audio.currentTime = 0;
  });
  
  // Create and play preview
  const audio = new Audio(url);
  audio.play().catch(e => console.log('Audio play failed:', e));
  
  // Auto-close preview after 10 seconds
  setTimeout(() => {
    audio.pause();
  }, 10000);
}

function clearSelectedMusic() {
  selectedMusic = null;
  updateSelectedAssets();
}

// ENHANCED STICKER SELECTOR WITH SCROLLABLE INTERFACE
function showStickerSelector() {
  const modal = document.getElementById('stickerSelectorModal');
  const selector = document.getElementById('stickerSelector');
  
  if (!modal || !selector) {
    console.error('Sticker selector elements not found');
    return;
  }
  
  let html = `
    <div class="sticker-selector">
      <div class="sticker-search-container">
        <input type="text" id="stickerSearch" placeholder="🔍 Search stickers..." class="sticker-search">
      </div>
      <div class="sticker-categories-tabs">
        ${Object.keys(stickerLibrary).map(category => 
          `<button class="sticker-tab-btn" onclick="switchStickerCategory('${category}')">${category.charAt(0).toUpperCase() + category.slice(1)}</button>`
        ).join('')}
      </div>
      <div class="sticker-content-area">
        <div id="stickerCategoryContent" class="sticker-category-content"></div>
      </div>
      <div class="sticker-selection-info">
        <span>Selected: ${selectedStickers.length}/5 stickers</span>
        <button class="clear-stickers-btn" onclick="clearSelectedStickers()">Clear All</button>
      </div>
    </div>
  `;
  
  selector.innerHTML = html;
  modal.style.display = 'flex';
  
  // Initialize first category
  switchStickerCategory('emotions');
  
  // Add search functionality
  const searchInput = document.getElementById('stickerSearch');
  if (searchInput) {
    searchInput.addEventListener('input', searchStickers);
  }
}

function switchStickerCategory(category) {
  const content = document.getElementById('stickerCategoryContent');
  if (!content) return;
  
  // Update active tab
  document.querySelectorAll('.sticker-tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.querySelector(`.sticker-tab-btn[onclick*="${category}"]`)?.classList.add('active');
  
  const stickers = stickerLibrary[category] || [];
  
  let html = `
    <div class="sticker-category">
      <h4>${category.charAt(0).toUpperCase() + category.slice(1)}</h4>
      <div class="sticker-grid">
        ${stickers.map(sticker => {
          const isSelected = selectedStickers.some(s => s.id === sticker.id);
          return `
            <div class="sticker-item ${isSelected ? 'selected' : ''}" onclick="selectSticker('${sticker.id}')" title="${sticker.name}">
              <span style="font-size: 32px;">${sticker.emoji}</span>
              <div class="sticker-name">${sticker.name}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
  
  content.innerHTML = html;
}

function searchStickers() {
  const searchTerm = document.getElementById('stickerSearch').value.toLowerCase().trim();
  const content = document.getElementById('stickerCategoryContent');
  
  if (!content) return;
  
  if (!searchTerm) {
    // If search is empty, show current category
    const activeTab = document.querySelector('.sticker-tab-btn.active');
    if (activeTab) {
      const category = activeTab.textContent.toLowerCase();
      switchStickerCategory(category);
    }
    return;
  }
  
  // Search across all categories
  let allStickers = [];
  Object.values(stickerLibrary).forEach(categoryStickers => {
    allStickers = allStickers.concat(categoryStickers);
  });
  
  const filteredStickers = allStickers.filter(sticker => 
    sticker.name.toLowerCase().includes(searchTerm) || 
    sticker.emoji.includes(searchTerm)
  );
  
  let html = `
    <div class="sticker-category">
      <h4>Search Results for "${searchTerm}"</h4>
      ${filteredStickers.length > 0 ? `
        <div class="sticker-grid">
          ${filteredStickers.map(sticker => {
            const isSelected = selectedStickers.some(s => s.id === sticker.id);
            return `
              <div class="sticker-item ${isSelected ? 'selected' : ''}" onclick="selectSticker('${sticker.id}')" title="${sticker.name}">
                <span style="font-size: 32px;">${sticker.emoji}</span>
                <div class="sticker-name">${sticker.name}</div>
              </div>
            `;
          }).join('')}
        </div>
      ` : `
        <div class="no-stickers-found">
          <p>No stickers found for "${searchTerm}"</p>
          <p>Try searching with different keywords</p>
        </div>
      `}
    </div>
  `;
  
  content.innerHTML = html;
}

function selectSticker(stickerId) {
  // Find sticker in all categories
  let selectedSticker = null;
  for (const category in stickerLibrary) {
    const sticker = stickerLibrary[category].find(s => s.id === stickerId);
    if (sticker) {
      selectedSticker = sticker;
      break;
    }
  }
  
  if (!selectedSticker) return;
  
  // Check if already selected
  const alreadySelected = selectedStickers.some(s => s.id === stickerId);
  if (alreadySelected) {
    selectedStickers = selectedStickers.filter(s => s.id !== stickerId);
    msg(`🗑️ Removed ${selectedSticker.emoji} sticker`, 'success');
  } else {
    if (selectedStickers.length >= 5) {
      msg('⚠️ Maximum 5 stickers per post', 'error');
      return;
    }
    selectedStickers.push(selectedSticker);
    msg(`🎨 Added ${selectedSticker.emoji} sticker`, 'success');
  }
  
  updateSelectedAssets();
  
  // Update the sticker selection info
  const selectionInfo = document.querySelector('.sticker-selection-info');
  if (selectionInfo) {
    selectionInfo.querySelector('span').textContent = `Selected: ${selectedStickers.length}/5 stickers`;
  }
  
  // Refresh current view to show updated selection state
  const searchInput = document.getElementById('stickerSearch');
  if (searchInput && searchInput.value.trim()) {
    searchStickers();
  } else {
    const activeTab = document.querySelector('.sticker-tab-btn.active');
    if (activeTab) {
      const category = activeTab.textContent.toLowerCase();
      switchStickerCategory(category);
    }
  }
}

function clearSelectedStickers() {
  selectedStickers = [];
  updateSelectedAssets();
  msg('🗑️ All stickers removed', 'success');
  
  // Update the sticker selection info
  const selectionInfo = document.querySelector('.sticker-selection-info');
  if (selectionInfo) {
    selectionInfo.querySelector('span').textContent = `Selected: 0/5 stickers`;
  }
  
  // Refresh current view
  const searchInput = document.getElementById('stickerSearch');
  if (searchInput && searchInput.value.trim()) {
    searchStickers();
  } else {
    const activeTab = document.querySelector('.sticker-tab-btn.active');
    if (activeTab) {
      const category = activeTab.textContent.toLowerCase();
      switchStickerCategory(category);
    }
  }
}

// UPDATE SELECTED ASSETS DISPLAY
function updateSelectedAssets() {
  const container = document.getElementById('selectedAssets');
  if (!container) return;
  
  let html = '';
  
  // Show selected music
  if (selectedMusic) {
    html += `
      <div class="selected-asset">
        <span>🎵 ${selectedMusic.name}</span>
        <button onclick="clearSelectedMusic()">✕</button>
      </div>
    `;
  }
  
  // Show selected stickers
  selectedStickers.forEach((sticker, index) => {
    html += `
      <div class="selected-asset">
        <span>${sticker.emoji}</span>
        <button onclick="removeSticker(${index})">✕</button>
      </div>
    `;
  });
  
  container.innerHTML = html;
  container.style.display = html ? 'block' : 'none';
}

function removeSticker(index) {
  selectedStickers.splice(index, 1);
  updateSelectedAssets();
  msg('🗑️ Sticker removed', 'success');
}

function showPostDestinationModal() {
  document.getElementById('postDestinationModal').style.display = 'flex';
}

function selectPostDestination(destination) {
  selectedPostDestination = destination;
  closeModal('postDestinationModal');
  msg(`Post will be shared to ${destination === 'profile' ? 'your profile' : 'community feed'}`, 'success');
}

// ENHANCED PHOTO UPLOAD WITH CROP FUNCTIONALITY
function openPhotoGallery() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,video/*';
  input.multiple = true;
  
  input.onchange = function(e) {
    handleFileSelection(e);
  };
  
  input.click();
}

function openCamera() {
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: true })
      .then(function(stream) {
        msg('📷 Camera access granted. Taking photo...', 'success');
        // In a real app, you would capture the photo here
        // For now, fall back to file input
        setTimeout(() => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.capture = 'environment';
          input.onchange = function(e) {
            handleFileSelection(e);
          };
          input.click();
        }, 1000);
      })
      .catch(function(error) {
        console.error('Camera error:', error);
        msg('⚠️ Camera not available. Using gallery instead.', 'error');
        openPhotoGallery();
      });
  } else {
    msg('⚠️ Camera not supported. Using gallery instead.', 'error');
    openPhotoGallery();
  }
}

function handleFileSelection(e) {
  const files = Array.from(e.target.files);
  
  if (files.length + selectedFiles.length > 5) {
    msg('⚠️ Max 5 files', 'error');
    return;
  }
  
  files.forEach(file => {
    if (!file.type.match(/image.*/) && !file.type.match(/video.*/)) {
      msg('⚠️ Images/videos only', 'error');
      return;
    }
    
    if (file.size > 10 * 1024 * 1024) {
      msg('⚠️ File too large (max 10MB)', 'error');
      return;
    }
    
    selectedFiles.push(file);
    
    const previewUrl = URL.createObjectURL(file);
    previewUrls.push({
      url: previewUrl,
      type: file.type.startsWith('image') ? 'image' : 'video',
      file: file
    });
  });
  
  displayPhotoPreviews();
  msg('✅ ' + files.length + ' file(s) added', 'success');
}

function displayPhotoPreviews() {
  const container = document.getElementById('photoPreviewContainer');
  if (!container) {
    console.warn('Photo preview container not found');
    return;
  }
  
  if (previewUrls.length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  
  container.style.display = 'block';
  let html = '<div class="media-preview">';
  
  previewUrls.forEach((preview, index) => {
    html += `
      <div class="media-preview-item">
        ${preview.type === 'image' 
          ? `<img src="${preview.url}" alt="Preview ${index + 1}">` 
          : `<video src="${preview.url}" controls></video>`
        }
        <button onclick="removeSelectedFile(${index})">✕</button>
        ${preview.type === 'image' ? `
          <div class="media-actions">
            <button class="edit-btn" onclick="editPhoto(${index})">✏️ Edit</button>
            <button class="crop-btn" onclick="cropPhoto(${index})">✂️ Crop</button>
          </div>
        ` : ''}
      </div>
    `;
  });
  
  html += '</div>';
  html += `<div style="text-align:right; color:#888; font-size:12px; margin-top:5px;">${selectedFiles.length}/5 files selected</div>`;
  container.innerHTML = html;
}

function editPhoto(index) {
  const preview = previewUrls[index];
  if (preview.type !== 'image') {
    msg('⚠️ Can only edit images', 'error');
    return;
  }
  
  showPhotoEditor(preview, index);
}

function cropPhoto(index) {
  const preview = previewUrls[index];
  if (preview.type !== 'image') {
    msg('⚠️ Can only crop images', 'error');
    return;
  }
  
  showCropEditor(preview, index);
}

// ENHANCED PHOTO EDITOR WITH CROP FUNCTIONALITY
function showPhotoEditor(preview, index) {
  document.getElementById('photoEditorModal').style.display = 'flex';
  document.getElementById('editImage').src = preview.url;
  currentEditIndex = index;
  currentFilters = {};
}

function showCropEditor(preview, index) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="modal-box" style="max-width: 800px;">
      <span class="close" onclick="closeCropEditor()">&times;</span>
      <h2>✂️ Crop Photo</h2>
      <div class="crop-container">
        <div class="crop-preview">
          <img id="cropImage" src="${preview.url}" alt="Crop preview">
        </div>
        <div class="crop-controls">
          <div class="crop-aspect-ratios">
            <h4>Aspect Ratio:</h4>
            <div class="aspect-ratio-buttons">
              <button class="aspect-ratio-btn active" data-ratio="free">Free</button>
              <button class="aspect-ratio-btn" data-ratio="1">1:1</button>
              <button class="aspect-ratio-btn" data-ratio="16/9">16:9</button>
              <button class="aspect-ratio-btn" data-ratio="4/3">4:3</button>
              <button class="aspect-ratio-btn" data-ratio="3/2">3:2</button>
            </div>
          </div>
          <div class="crop-actions">
            <button class="btn-secondary" onclick="rotateImage()">🔄 Rotate</button>
            <button class="btn-secondary" onclick="resetCrop()">↩️ Reset</button>
            <button class="btn-primary" onclick="applyCrop(${index})">💾 Apply Crop</button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  currentCropIndex = index;
  
  // Initialize cropper
  setTimeout(() => {
    const image = document.getElementById('cropImage');
    if (image) {
      cropper = new Cropper(image, {
        aspectRatio: NaN, // Free ratio by default
        viewMode: 1,
        autoCropArea: 0.8,
        responsive: true,
        restore: true,
        checkCrossOrigin: false,
        guides: true,
        center: true,
        highlight: true,
        cropBoxMovable: true,
        cropBoxResizable: true,
        toggleDragModeOnDblclick: true
      });
    }
    
    // Add aspect ratio change handlers
    document.querySelectorAll('.aspect-ratio-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.aspect-ratio-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        
        const ratio = this.dataset.ratio;
        if (ratio === 'free') {
          cropper.setAspectRatio(NaN);
        } else {
          cropper.setAspectRatio(eval(ratio));
        }
      });
    });
  }, 100);
}

function closeCropEditor() {
  if (cropper) {
    cropper.destroy();
    cropper = null;
  }
  document.querySelector('.modal')?.remove();
}

function rotateImage() {
  if (cropper) {
    cropper.rotate(90);
  }
}

function resetCrop() {
  if (cropper) {
    cropper.reset();
  }
}

function applyCrop(index) {
  if (!cropper) return;
  
  const canvas = cropper.getCroppedCanvas();
  if (!canvas) return;
  
  canvas.toBlob((blob) => {
    const file = new File([blob], selectedFiles[index].name, { 
      type: 'image/jpeg',
      lastModified: new Date().getTime()
    });
    
    // Update selected files array
    selectedFiles[index] = file;
    
    // Update preview URL
    URL.revokeObjectURL(previewUrls[index].url);
    const newUrl = URL.createObjectURL(file);
    previewUrls[index] = { 
      url: newUrl, 
      type: 'image', 
      file: file 
    };
    
    // Refresh preview
    displayPhotoPreviews();
    
    // Close editor
    closeCropEditor();
    
    msg('✅ Photo cropped successfully!', 'success');
  }, 'image/jpeg', 0.9);
}

let currentEditIndex = -1;
let currentCropIndex = -1;
let currentFilters = {};

function applyFilter(filter) {
  const img = document.getElementById('editImage');
  if (!img) return;
  
  // Reset all filters first
  img.style.filter = '';
  
  switch(filter) {
    case 'normal':
      currentFilters = {};
      break;
    case 'vintage':
      currentFilters = { sepia: 70, contrast: 120, brightness: 110 };
      break;
    case 'clarendon':
      currentFilters = { contrast: 130, saturation: 120, brightness: 105 };
      break;
    case 'moon':
      currentFilters = { grayscale: 100, brightness: 90, contrast: 110 };
      break;
    case 'lark':
      currentFilters = { brightness: 115, saturation: 110, contrast: 105 };
      break;
    case 'reyes':
      currentFilters = { sepia: 50, brightness: 115, contrast: 105 };
      break;
  }
  
  updateImageFilters();
}

function updateImageFilters() {
  const img = document.getElementById('editImage');
  if (!img) return;
  
  let filterString = '';
  if (currentFilters.grayscale) filterString += `grayscale(${currentFilters.grayscale}%) `;
  if (currentFilters.sepia) filterString += `sepia(${currentFilters.sepia}%) `;
  if (currentFilters.brightness) filterString += `brightness(${currentFilters.brightness}%) `;
  if (currentFilters.contrast) filterString += `contrast(${currentFilters.contrast}%) `;
  if (currentFilters.saturation) filterString += `saturate(${currentFilters.saturation}%) `;
  if (currentFilters.blur) filterString += `blur(${currentFilters.blur}px) `;
  if (currentFilters.hue) filterString += `hue-rotate(${currentFilters.hue}deg) `;
  
  img.style.filter = filterString || 'none';
}

function resetFilters() {
  currentFilters = {};
  updateImageFilters();
}

function saveEditedPhoto() {
  const img = document.getElementById('editImage');
  if (!img || currentEditIndex === -1) return;
  
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Set canvas dimensions to match image
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    
    // Apply filters if any
    if (Object.keys(currentFilters).length > 0) {
      ctx.filter = img.style.filter;
    }
    
    // Draw image on canvas
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    
    // Convert to blob and update file
    canvas.toBlob((blob) => {
      const file = new File([blob], selectedFiles[currentEditIndex].name, { 
        type: 'image/jpeg',
        lastModified: new Date().getTime()
      });
      
      // Update selected files array
      selectedFiles[currentEditIndex] = file;
      
      // Update preview URL
      URL.revokeObjectURL(previewUrls[currentEditIndex].url);
      const newUrl = URL.createObjectURL(file);
      previewUrls[currentEditIndex] = { 
        url: newUrl, 
        type: 'image', 
        file: file 
      };
      
      // Refresh preview
      displayPhotoPreviews();
      
      // Close editor
      closeModal('photoEditorModal');
      currentEditIndex = -1;
      currentFilters = {};
      
      msg('✅ Photo edited successfully!', 'success');
    }, 'image/jpeg', 0.9);
  } catch (error) {
    console.error('Error saving edited photo:', error);
    msg('❌ Failed to save photo', 'error');
  }
}

function removeSelectedFile(index) {
  URL.revokeObjectURL(previewUrls[index].url);
  selectedFiles.splice(index, 1);
  previewUrls.splice(index, 1);
  displayPhotoPreviews();
  msg('🗑️ File removed', 'success');
}

function clearSelectedFiles() {
  previewUrls.forEach(preview => URL.revokeObjectURL(preview.url));
  selectedFiles = [];
  previewUrls = [];
  displayPhotoPreviews();
}

// COMMUNITIES WITH ENHANCED CHAT
function loadCommunities() {
  const container = document.getElementById('communitiesContainer');
  
  if (!currentUser || !currentUser.communityJoined) {
    container.innerHTML = `
      <div class="community-guidance">
        <p>🎓 Connect to your college first to join community chat!</p>
        <button class="home-nav-btn" onclick="showPage('home')">Explore Colleges</button>
      </div>
    `;
    return;
  }
  
  container.innerHTML = `
    <div class="community-card">
      <h3>${currentUser.college} Community</h3>
      <p>Chat with students from your college</p>
      <button onclick="openCommunityChat()">Open Chat</button>
    </div>
  `;
}

function openCommunityChat() {
  document.getElementById('chatSection').style.display = 'block';
  loadCommunityMessages();
}

async function loadCommunityMessages() {
  try {
    const data = await apiCall('/api/community/messages', 'GET');
    const messagesEl = document.getElementById('chatMessages');
    
    if (!data.messages || data.messages.length === 0) {
      messagesEl.innerHTML = '<div style="text-align:center; padding:20px; color:#888;">No messages yet. Start chatting!</div>';
      return;
    }
    
    messagesEl.innerHTML = '';
    data.messages.reverse().forEach(msg => {
      appendMessageToChat(msg);
    });
    
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } catch (error) {
    console.error('Load messages error:', error);
  }
}

function appendMessageToChat(msg) {
  const messagesEl = document.getElementById('chatMessages');
  if (!messagesEl) return;
  
  const isOwn = msg.sender_id === currentUser.id;
  const sender = msg.users?.username || 'User';
  const messageTime = new Date(msg.timestamp);
  const now = new Date();
  const canEdit = isOwn && ((now - messageTime) / 1000 / 60) < 2;
  
  const messageDiv = document.createElement('div');
  messageDiv.className = `chat-message ${isOwn ? 'own' : 'other'}`;
  messageDiv.id = `msg-${msg.id}`;
  
  const reactions = msg.message_reactions || [];
  const reactionCounts = {};
  reactions.forEach(r => {
    reactionCounts[r.emoji] = (reactionCounts[r.emoji] || 0) + 1;
  });
  
  messageDiv.innerHTML = `
    ${!isOwn ? `<div class="sender">@${sender}</div>` : ''}
    <div class="text">${msg.content}${msg.edited ? ' <span style="font-size:10px;color:#888;">(edited)</span>' : ''}</div>
    ${Object.keys(reactionCounts).length > 0 ? `
      <div style="display:flex; gap:5px; margin-top:5px; flex-wrap:wrap;">
        ${Object.entries(reactionCounts).map(([emoji, count]) => 
          `<span style="background:rgba(79,116,163,0.2); padding:2px 6px; border-radius:10px; font-size:12px;">${emoji} ${count}</span>`
        ).join('')}
      </div>
    ` : ''}
    <div style="display:flex; gap:8px; margin-top:8px; font-size:11px; color:#888;">
      <span onclick="reactToMessage('${msg.id}')" style="cursor:pointer;">❤️</span>
      <span onclick="reactToMessage('${msg.id}', '👍')" style="cursor:pointer;">👍</span>
      <span onclick="reactToMessage('${msg.id}', '😂')" style="cursor:pointer;">😂</span>
      <span onclick="reactToMessage('${msg.id}', '🔥')" style="cursor:pointer;">🔥</span>
      ${canEdit ? `<span onclick="editMessage('${msg.id}', '${msg.content.replace(/'/g, "\\'")}')" style="cursor:pointer;">✏️ Edit</span>` : ''}
      ${isOwn ? `<span onclick="deleteMessage('${msg.id}')" style="cursor:pointer;">🗑️ Delete</span>` : ''}
      <span onclick="showMessageViews('${msg.id}')" style="cursor:pointer;">👁️ Views</span>
    </div>
  `;
  
  messagesEl.appendChild(messageDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  
  markMessageAsViewed(msg.id);
}

function updateMessageInChat(msg) {
  const messageEl = document.getElementById(`msg-${msg.id}`);
  if (!messageEl) return;
  
  const isOwn = msg.sender_id === currentUser.id;
  const textEl = messageEl.querySelector('.text');
  if (textEl) {
    textEl.innerHTML = `${msg.content} <span style="font-size:10px;color:#888;">(edited)</span>`;
  }
}

function removeMessageFromChat(id) {
  const messageEl = document.getElementById(`msg-${id}`);
  if (messageEl) {
    messageEl.remove();
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const content = input.value.trim();
  
  if (!content) return;
  
  try {
    await apiCall('/api/community/messages', 'POST', { content });
    input.value = '';
  } catch (error) {
    msg('❌ Failed to send message', 'error');
  }
}

function handleChatKeypress(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
}

async function editMessage(messageId, currentContent) {
  if (editingMessageId) {
    msg('⚠️ Finish editing current message first', 'error');
    return;
  }
  
  const newContent = prompt('Edit message:', currentContent);
  if (!newContent || newContent.trim() === '' || newContent === currentContent) return;
  
  try {
    editingMessageId = messageId;
    await apiCall(`/api/community/messages/${messageId}`, 'PATCH', { content: newContent.trim() });
    msg('✅ Message edited', 'success');
  } catch (error) {
    msg('❌ ' + error.message, 'error');
  } finally {
    editingMessageId = null;
  }
}

async function deleteMessage(messageId) {
  if (!confirm('Delete this message?')) return;
  
  try {
    await apiCall(`/api/community/messages/${messageId}`, 'DELETE');
    msg('🗑️ Message deleted', 'success');
  } catch (error) {
    msg('❌ Failed to delete', 'error');
  }
}

async function reactToMessage(messageId, emoji = '❤️') {
  try {
    await apiCall(`/api/community/messages/${messageId}/react`, 'POST', { emoji });
  } catch (error) {
    console.error('React error:', error);
  }
}

async function markMessageAsViewed(messageId) {
  try {
    await apiCall(`/api/community/messages/${messageId}/view`, 'POST');
  } catch (error) {
    console.error('View error:', error);
  }
}

async function showMessageViews(messageId) {
  try {
    const data = await apiCall(`/api/community/messages/${messageId}/views`, 'GET');
    
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="modal-box">
        <span class="close" onclick="this.parentElement.parentElement.remove()">&times;</span>
        <h2>Message Views (${data.count})</h2>
        ${data.views.length > 0 ? `
          <div style="max-height:300px; overflow-y:auto;">
            ${data.views.map(v => `
              <div style="padding:10px; border-bottom:1px solid rgba(79,116,163,0.1);">
                <strong>@${v.users?.username || 'User'}</strong>
              </div>
            `).join('')}
          </div>
        ` : '<p style="text-align:center; color:#888;">No views yet</p>'}
      </div>
    `;
    document.body.appendChild(modal);
  } catch (error) {
    msg('❌ Failed to load views', 'error');
  }
}

// SEARCH BAR
function initializeSearchBar() {
  const searchBox = document.querySelector('.search-box');
  if (!searchBox) return;
  
  let searchTimeout;
  searchBox.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim();
    
    if (query.length < 2) {
      hideSearchResults();
      return;
    }
    
    searchTimeout = setTimeout(() => {
      performSearch(query);
    }, 500);
  });
  
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box') && !e.target.closest('.search-results')) {
      hideSearchResults();
    }
  });
}

async function performSearch(query) {
  try {
    const data = await apiCall(`/api/search/users?query=${encodeURIComponent(query)}`, 'GET');
    displaySearchResults(data.users || []);
  } catch (error) {
    console.error('Search error:', error);
  }
}

function displaySearchResults(users) {
  let resultsDiv = document.querySelector('.search-results');
  
  if (!resultsDiv) {
    resultsDiv = document.createElement('div');
    resultsDiv.className = 'search-results';
    resultsDiv.style.cssText = `
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: rgba(15, 25, 45, 0.98);
      border: 1px solid rgba(79, 116, 163, 0.3);
      border-radius: 12px;
      margin-top: 5px;
      max-height: 400px;
      overflow-y: auto;
      z-index: 1000;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    `;
    
    const searchContainer = document.querySelector('.search-box').parentElement;
    searchContainer.style.position = 'relative';
    searchContainer.appendChild(resultsDiv);
  }
  
  if (users.length === 0) {
    resultsDiv.innerHTML = '<div style="padding:20px; text-align:center; color:#888;">No users found</div>';
    return;
  }
  
  resultsDiv.innerHTML = users.map(user => `
    <div onclick="showUserProfile('${user.id}')" style="padding:15px; border-bottom:1px solid rgba(79,116,163,0.1); cursor:pointer; transition:all 0.2s;" onmouseover="this.style.background='rgba(79,116,163,0.1)'" onmouseout="this.style.background='transparent'">
      <div style="display:flex; align-items:center; gap:12px;">
        <div style="width:40px; height:40px; border-radius:50%; background:linear-gradient(135deg, rgba(79,116,163,0.3), rgba(141,164,211,0.3)); display:flex; align-items:center; justify-content:center; font-size:20px;">
          ${user.profile_pic ? `<img src="${user.profile_pic}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : '👤'}
        </div>
        <div style="flex:1;">
          <div style="font-weight:600; color:#4f74a3;">@${user.username}</div>
          <div style="font-size:12px; color:#888;">${user.registration_number || user.email}</div>
          ${user.college ? `<div style="font-size:11px; color:#666; margin-top:2px;">🎓 ${user.college}</div>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

function hideSearchResults() {
  const resultsDiv = document.querySelector('.search-results');
  if (resultsDiv) {
    resultsDiv.remove();
  }
}

async function showUserProfile(userId) {
  hideSearchResults();
  
  try {
    const data = await apiCall(`/api/profile/${userId}`, 'GET');
    const user = data.user;
    
    showProfileModal(user);
  } catch (error) {
    msg('❌ Failed to load profile', 'error');
  }
}

// PROFILE PAGE
function showProfilePage() {
  if (!currentUser) return;
  showProfileModal(currentUser);
  document.getElementById('hamburgerMenu').style.display = 'none';
  document.getElementById('optionsMenu').style.display = 'none';
}

function showProfileModal(user) {
  const isOwnProfile = currentUser && user.id === currentUser.id;
  
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="modal-box profile-modal-box">
      <button class="close-profile" onclick="this.parentElement.parentElement.remove()">&times;</button>
      
      <div class="profile-container">
        <div class="profile-header">
          <div class="profile-cover"></div>
          <div class="profile-main">
            <div class="profile-photo-section">
              <div class="profile-photo" style="${user.profile_pic ? `background-image: url('${user.profile_pic}'); background-size: cover;` : ''}">
                ${!user.profile_pic ? '👤' : ''}
              </div>
              ${isOwnProfile ? `
                <button class="avatar-upload-btn" onclick="uploadProfilePic()">📷 Change Avatar</button>
              ` : ''}
              <div class="active-badge">
                <span class="status-dot"></span>
                <span>Active Now</span>
              </div>
            </div>
            
            <div class="profile-name-section">
              <h2>${user.username}</h2>
              <div class="nickname-display">
                <span class="nickname-label">@${user.username}</span>
              </div>
              ${user.college ? `<p style="color:#888; font-size:14px;">🎓 ${user.college}</p>` : ''}
              ${user.registration_number ? `<p style="color:#888; font-size:13px;">📋 ${user.registration_number}</p>` : ''}
            </div>
            
            ${isOwnProfile ? `
              <button class="profile-edit-btn" onclick="toggleEditProfile()">✏️ Edit Profile</button>
            ` : ''}
          </div>
        </div>
        
        <div class="profile-stats-section">
          <div class="stat-card">
            <div class="stat-icon">📝</div>
            <div class="stat-value">${user.postCount || 0}</div>
            <div class="stat-title">Posts</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">🏆</div>
            <div class="stat-value">${user.badges?.length || 0}</div>
            <div class="stat-title">Badges</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">⏱️</div>
            <div class="stat-value">24h</div>
            <div class="stat-title">Active</div>
          </div>
        </div>
        
        <div class="profile-description-section">
          <h3>About</h3>
          <p id="profileDescriptionText">${user.bio || 'No description added yet. Click edit to add one!'}</p>
        </div>
        
        ${isOwnProfile ? `
          <div class="edit-profile-section" id="editProfileSection" style="display:none;">
            <h3>Edit Profile</h3>
            <div class="edit-form-group">
              <label>Username</label>
              <input type="text" id="editUsername" value="${user.username}" maxlength="30">
            </div>
            <div class="edit-form-group">
              <label>Bio</label>
              <textarea id="editBio" maxlength="200" rows="4" placeholder="Tell us about yourself...">${user.bio || ''}</textarea>
              <small id="bioCounter">0/200</small>
            </div>
            <div class="edit-form-buttons">
              <button class="btn-save" onclick="saveProfile()">💾 Save</button>
              <button class="btn-cancel" onclick="toggleEditProfile()">❌ Cancel</button>
            </div>
          </div>
        ` : ''}
        
        ${user.badges && user.badges.length > 0 ? `
          <div style="background:rgba(15,25,45,0.9); border:1px solid rgba(79,116,163,0.2); border-radius:12px; padding:20px; margin-top:20px;">
            <h3 style="color:#4f74a3; margin-bottom:15px;">🏆 Badges</h3>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
              ${user.badges.map(badge => `
                <span style="background:linear-gradient(135deg, rgba(79,116,163,0.2), rgba(141,164,211,0.2)); border:1px solid rgba(79,116,163,0.3); padding:8px 16px; border-radius:20px; font-size:14px;">${badge}</span>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  
  if (isOwnProfile) {
    const bioTextarea = document.getElementById('editBio');
    if (bioTextarea) {
      bioTextarea.addEventListener('input', updateBioCounter);
      updateBioCounter();
    }
  }
}

function toggleEditProfile() {
  const section = document.getElementById('editProfileSection');
  if (!section) return;
  
  section.style.display = section.style.display === 'none' ? 'block' : 'none';
}

function updateBioCounter() {
  const textarea = document.getElementById('editBio');
  const counter = document.getElementById('bioCounter');
  if (textarea && counter) {
    counter.textContent = `${textarea.value.length}/200`;
  }
}

async function saveProfile() {
  const username = document.getElementById('editUsername')?.value.trim();
  const bio = document.getElementById('editBio')?.value.trim();
  
  if (!username) {
    msg('⚠️ Username required', 'error');
    return;
  }
  
  try {
    const data = await apiCall('/api/profile', 'PATCH', { username, bio });
    
    if (data.success) {
      currentUser.username = data.user.username;
      currentUser.bio = data.user.bio;
      localStorage.setItem('user', JSON.stringify(currentUser));
      
      msg('✅ Profile updated!', 'success');
      document.querySelector('.modal')?.remove();
      showProfilePage();
    }
  } catch (error) {
    msg('❌ ' + error.message, 'error');
  }
}

function uploadProfilePic() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  
  input.onchange = async function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    if (file.size > 5 * 1024 * 1024) {
      msg('⚠️ Image too large (max 5MB)', 'error');
      return;
    }
    
    try {
      const formData = new FormData();
      formData.append('profilePic', file);
      
      const data = await apiCall('/api/profile', 'PATCH', formData);
      
      if (data.success) {
        currentUser.profile_pic = data.user.profile_pic;
        localStorage.setItem('user', JSON.stringify(currentUser));
        
        msg('✅ Profile picture updated!', 'success');
        document.querySelector('.modal')?.remove();
        showProfilePage();
      }
    } catch (error) {
      msg('❌ Failed to upload', 'error');
    }
  };
  
  input.click();
}

// BADGES PAGE
function loadBadgesPage() {
  const container = document.getElementById('badges');
  if (!container) return;
  
  const allBadges = [
    { emoji: '🎓', name: 'Community Member', desc: 'Joined a college community', earned: currentUser?.badges?.includes('🎓 Community Member') },
    { emoji: '🎨', name: 'First Post', desc: 'Created your first post', earned: currentUser?.badges?.includes('🎨 First Post') },
    { emoji: '⭐', name: 'Content Creator', desc: 'Posted 10 times', earned: currentUser?.badges?.includes('⭐ Content Creator') },
    { emoji: '💬', name: 'Chatty', desc: 'Sent 50 messages', earned: false },
    { emoji: '🔥', name: 'On Fire', desc: '7 day streak', earned: false },
  ];
  
  let html = `
    <div style="text-align:center; margin-bottom:40px;">
      <h2 style="font-size:32px; color:#4f74a3; margin-bottom:10px;">🏆 Badges</h2>
      <p style="color:#888;">Earn badges by being active in the community!</p>
    </div>
    <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); gap:20px;">
  `;
  
  allBadges.forEach(badge => {
    html += `
      <div style="background:${badge.earned ? 'linear-gradient(135deg, rgba(79,116,163,0.2), rgba(141,164,211,0.2))' : 'rgba(15,25,45,0.9)'}; border:2px solid ${badge.earned ? '#4f74a3' : 'rgba(79,116,163,0.2)'}; border-radius:16px; padding:30px 20px; text-align:center; transition:all 0.3s ease;" ${badge.earned ? 'style="box-shadow:0 10px 30px rgba(79,116,163,0.3);"' : ''}>
        <div style="font-size:48px; margin-bottom:15px; filter:${badge.earned ? 'none' : 'grayscale(100%) opacity(0.3)'};">${badge.emoji}</div>
        <h3 style="color:${badge.earned ? '#4f74a3' : '#666'}; font-size:18px; margin-bottom:8px;">${badge.name}</h3>
        <p style="color:#888; font-size:13px; margin-bottom:15px;">${badge.desc}</p>
        <div style="background:${badge.earned ? 'linear-gradient(135deg, #4f74a3, #8da4d3)' : 'rgba(79,116,163,0.1)'}; color:${badge.earned ? 'white' : '#666'}; padding:8px 16px; border-radius:20px; font-size:12px; font-weight:600; display:inline-block;">
          ${badge.earned ? '✓ Earned' : '🔒 Locked'}
        </div>
      </div>
    `;
  });
  
  html += '</div>';
  container.innerHTML = html;
}

// FEEDBACK
function showFeedbackModal() {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="modal-box">
      <span class="close" onclick="this.parentElement.parentElement.remove()">&times;</span>
      <h2>📢 Send Feedback</h2>
      <p style="color:#888; margin-bottom:20px;">We'd love to hear from you!</p>
      <input type="text" id="feedbackSubject" placeholder="Subject" style="margin-bottom:15px;">
      <textarea id="feedbackMessage" placeholder="Your feedback..." style="width:100%; min-height:120px; padding:12px; background:rgba(20,30,50,0.6); border:1px solid rgba(79,116,163,0.3); border-radius:10px; color:white; font-family:inherit; resize:vertical;"></textarea>
      <button onclick="submitFeedback()" style="width:100%; margin-top:15px;">📤 Send Feedback</button>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('hamburgerMenu').style.display = 'none';
  document.getElementById('optionsMenu').style.display = 'none';
}

async function submitFeedback() {
  const subject = document.getElementById('feedbackSubject')?.value.trim();
  const message = document.getElementById('feedbackMessage')?.value.trim();
  
  if (!subject || !message) {
    msg('⚠️ Please fill all fields', 'error');
    return;
  }
  
  try {
    await apiCall('/api/feedback', 'POST', { subject, message });
    msg('✅ Thank you for your feedback!', 'success');
    document.querySelector('.modal')?.remove();
  } catch (error) {
    msg('❌ Failed to submit feedback', 'error');
  }
}

// MODALS
function closeModal(id) {
  const modal = document.getElementById(id);
  if(modal) modal.style.display = 'none';
}

function showComplaintModal() {
  document.getElementById('complaintModal').style.display = 'flex';
  document.getElementById('hamburgerMenu').style.display = 'none';
  document.getElementById('optionsMenu').style.display = 'none';
}

function showContactModal() {
  document.getElementById('contactModal').style.display = 'flex';
  document.getElementById('hamburgerMenu').style.display = 'none';
  document.getElementById('optionsMenu').style.display = 'none';
}

function submitComplaint() {
  const text = document.getElementById('complaintText').value.trim();
  if (text) {
    msg('✅ Complaint submitted!', 'success');
    document.getElementById('complaintText').value = '';
    closeModal('complaintModal');
  } else {
    msg('⚠️ Enter complaint details', 'error');
  }
}

function toggleTheme() {
  const body = document.body;
  if(body.classList.contains('dark-theme')) {
    body.classList.remove('dark-theme');
    body.classList.add('light-theme');
  } else {
    body.classList.remove('light-theme');
    body.classList.add('dark-theme');
  }
  msg('🎨 Theme changed!', 'success');
  document.getElementById('hamburgerMenu').style.display = 'none';
  document.getElementById('optionsMenu').style.display = 'none';
}

// MENUS
function toggleOptionsMenu() {
  const menu = document.getElementById('optionsMenu');
  const hamburger = document.getElementById('hamburgerMenu');
  hamburger.style.display = 'none';
  
  if(menu.style.display === 'none' || menu.style.display === '') {
    menu.style.display = 'block';
  } else {
    menu.style.display = 'none';
  }
}

function toggleHamburgerMenu() {
  const menu = document.getElementById('hamburgerMenu');
  const options = document.getElementById('optionsMenu');
  options.style.display = 'none';
  
  if(menu.style.display === 'none' || menu.style.display === '') {
    menu.style.display = 'block';
  } else {
    menu.style.display = 'none';
  }
}

// Close menus when clicking outside
document.addEventListener('click', function(e) {
  const optionsMenu = document.getElementById('optionsMenu');
  const optionsBtn = document.querySelector('.options-btn');
  const hamburgerMenu = document.getElementById('hamburgerMenu');
  const hamburgerBtn = document.querySelector('.hamburger-btn');
  
  if (optionsMenu && !optionsMenu.contains(e.target) && e.target !== optionsBtn && !optionsBtn?.contains(e.target)) {
    optionsMenu.style.display = 'none';
  }
  
  if (hamburgerMenu && !hamburgerMenu.contains(e.target) && e.target !== hamburgerBtn && !hamburgerBtn?.contains(e.target)) {
    hamburgerMenu.style.display = 'none';
  }
});

// LIVE STATS
function updateLiveStats() {
  const onlineCount = Math.floor(Math.random() * 300) + 150;
  const postsToday = Math.floor(Math.random() * 500) + 200;
  const activeChats = Math.floor(Math.random() * 100) + 50;
  
  const elements = {
    'liveUsersCount': onlineCount + ' Active',
    'heroOnline': onlineCount,
    'heroPostsToday': postsToday,
    'heroChats': activeChats,
    'footerUsers': onlineCount
  };
  
  Object.keys(elements).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = elements[id];
  });
}

function updateOnlineCount(count) {
  const elements = ['liveUsersCount', 'heroOnline', 'chatOnlineCount', 'footerUsers'];
  elements.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (id === 'liveUsersCount') {
        el.textContent = count + ' Active';
      } else if (id === 'footerUsers') {
        el.textContent = count;
      } else {
        el.textContent = count;
      }
    }
  });
}

function updateLiveNotif(text) {
  const notif = document.getElementById('notifText');
  if (notif) notif.textContent = text;
}

// MESSAGE
function msg(text, type) {
  const box = document.getElementById('message');
  if(!box) {
    console.log('Message:', text);
    return;
  }
  
  const div = document.createElement('div');
  div.className = 'msg msg-' + type;
  div.textContent = text;
  box.innerHTML = '';
  box.appendChild(div);
  
  setTimeout(() => {
    if(div.parentNode) div.remove();
  }, 4000);
}

// TRENDING (Mock data)
function loadTrending() {
  const container = document.getElementById('trendingContainer');
  if (!container) return;
  
  const trending = [
    { title: 'Campus Fest 2025', badge: 'Hot', text: 'Annual cultural festival starting next week!', likes: 234, comments: 45 },
    { title: 'Study Groups', badge: 'New', text: 'Join semester exam preparation groups', likes: 156, comments: 23 },
    { title: 'Sports Week', badge: 'Popular', text: 'Inter-college sports competition registrations open', likes: 189, comments: 67 }
  ];
  
  let html = '';
  trending.forEach(item => {
    html += `
      <div class="trending-card">
        <div class="trending-card-header">
          <div class="trending-title">${item.title}</div>
          <div class="trending-badge">${item.badge}</div>
        </div>
        <div class="trending-text">${item.text}</div>
        <div class="trending-footer">
          <div class="trending-engagement">
            <div class="engagement-item">❤️ ${item.likes}</div>
            <div class="engagement-item">💬 ${item.comments}</div>
          </div>
        </div>
      </div>
    `;
  });
  
  container.innerHTML = html;
}

console.log('✅ VibeXpert Enhanced - All features loaded and functional!');
