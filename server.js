const express = require('express');
const ejs = require('ejs');
const app = express();
const port = 4000;
const { MongoClient, ObjectId } = require('mongodb');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local');
const bcrypt = require('bcrypt');
const MongoStore = require('connect-mongo');
const NaverStrategy = require('passport-naver').Strategy;
const dotenv = require('dotenv');
const csrf = require('csurf');
const { body, param, query, validationResult } = require('express-validator');
dotenv.config();

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');

// Render 등 프록시 환경에서 secure 쿠키/CSRF 정상 동작을 위해 신뢰 설정
app.set('trust proxy', 1);

app.use(express.static(__dirname + '/public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 세션/쿠키 보안 강화
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave : false,
  saveUninitialized : false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 365,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  },
  store: MongoStore.create({
    mongoUrl : process.env.MONGODB_URI,
    dbName: 'CancerDiary',
  })
}));

app.use(passport.initialize());
app.use(passport.session());

// CSRF 보호 (API 라우트 제외)
const csrfProtection = csrf();
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return csrfProtection(req, res, next);
});

app.use((req, res, next) => {
  if (typeof req.csrfToken === 'function') {
    res.locals.csrfToken = req.csrfToken();
  }
  next();
});

// 공통 유틸 (비동기 에러 전파)
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const requireLogin = (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  next();
};

// NoSQL Injection 방지를 위한 문자열 검사
const isSafeString = (value) => {
  if (typeof value !== 'string') return false;
  if (value.includes('$') || value.includes('.')) return false;
  return true;
};

const sanitizeText = (value) => value.trim();

// 입력값 검증 에러 처리
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    if (req.path.startsWith('/api/')) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    return res.status(400).render('400.ejs');
  }
  next();
};

// API 전용 에러 메시지 유지 (기존 JSON 구조 유지)
const handleFoodApiValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: '음식 이름이 필요합니다.' });
  }
  next();
};

const getRecentRecords = async (collectionName, userId, limit = 7) => {
  const records = await db.collection(collectionName)
    .find({ userId })
    .sort({ date: -1 })
    .limit(limit)
    .toArray();
  return records.reverse();
};

const moodToScore = (value) => {
  const map = {
    'very-good': 5,
    'good': 4,
    'okay': 3,
    'bad': 2,
    'very-bad': 1
  };
  return map[value] || 0;
};

const mealTypes = ['breakfast', 'morningsnack', 'lunch', 'afternoonsnack', 'dinner', 'latesnack'];
const moodTypes = ['very-good', 'good', 'okay', 'bad', 'very-bad'];
const energyTypes = ['high', 'medium', 'low'];
const intensityTypes = ['low', 'medium', 'high'];
const bowelStatusTypes = ['normal', 'soft', 'hard', 'other'];
const susulTypes = ['before', 'after'];
const hangamTypes = ['hangam-first', 'hangam-later', 'none', 'unknown'];
const stageTypes = ['1', '2', '3', '4', 'none'];

passport.use(new LocalStrategy(async (inputUsername, inputPassword, cb) => {
  try {
    if (!isSafeString(inputUsername)) {
      return cb(null, false, { message: 'Invalid input' });
    }
    const username = sanitizeText(inputUsername);
    const result = await db.collection('users').findOne({ username });
    if (!result) {
      return cb(null, false, { message: '아이디 DB에 없음' });
    }
    const ok = await bcrypt.compare(inputPassword, result.password);
    if (ok) return cb(null, result);
    return cb(null, false, { message: '비번불일치' });
  } catch (err) {
    return cb(err);
  }
}));

passport.use(new NaverStrategy({
  clientID: process.env.NAVER_CLIENT_ID,
  clientSecret: process.env.NAVER_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const userData = {
      username: profile.id,
      nickname: profile.displayName,
      email: profile._json.email,
      profileImage: profile._json.profile_image,
      age: profile._json.age,
      provider: 'naver'
    };

    let user = await db.collection('users').findOne({ username: userData.username });
    if (!user) {
      // 새 유저면 DB에 저장
      await db.collection('users').insertOne(userData);
    }
    return done(null, user || userData);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => {
  process.nextTick(() => {
    done(null, {
      id: user._id ? user._id : user.username,
      username: user.username
    });
  });
});

passport.deserializeUser(async (user, done) => {
  try {
    let result = null;
    if (ObjectId.isValid(user.id)) {
      result = await db.collection('users').findOne({ _id: new ObjectId(user.id) });
    } else if (isSafeString(user.id)) {
      result = await db.collection('users').findOne({ username: sanitizeText(user.id) });
    }
    process.nextTick(() => done(null, result));
  } catch (err) {
    process.nextTick(() => done(err));
  }
});

let db;
const url = process.env.MONGODB_URI;
new MongoClient(url).connect().then((client) => {
  console.log('DB연결성공');
  db = client.db('CancerDiary');

  app.listen(port, '0.0.0.0', () => {
    console.log('Server is running on http://localhost:' + port);
  });
}).catch((err) => {
  console.log(err);
});

app.get('/', (req, res) => {
  if (req.user) return res.redirect('/home');
  return res.redirect('/login');
});

app.get('/next',
  [
    query('Code').optional().isString().custom(isSafeString),
    query('Name').optional().isString().custom(isSafeString)
  ],
  handleValidation,
  (req, res) => {
    const sickCode = sanitizeText(req.query.Code || '');
    const sickName = sanitizeText(req.query.Name || '');
    res.render('next.ejs', { Code: sickCode, Name: sickName });
  }
);

app.get('/home', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  return res.redirect('/login');
});

app.get('/login',
  [ query('error').optional().isString().custom(isSafeString) ],
  handleValidation,
  (req, res) => {
    if (req.user) return res.redirect('/dashboard');
    const error = req.query.error === 'invalid';
    res.render('login.ejs', { error });
  }
);

app.get('/register', (req, res) => {
  res.render('register.ejs');
});

app.get('/forgot-password', (req, res) => {
  res.render('forgot-password.ejs');
});

app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.redirect('/login');
    });
  });
});

app.post('/login',
  [
    body('username').isString().isLength({ min: 2, max: 50 }).custom(isSafeString).trim(),
    body('password').isString().isLength({ min: 4, max: 100 })
  ],
  handleValidation,
  (req, res, next) => {
    passport.authenticate('local', (error, user) => {
      if (error) return next(error);
      if (!user) return res.redirect('/login?error=invalid');
      req.logIn(user, (err) => {
        if (err) return next(err);
        res.redirect('/');
      });
    })(req, res, next);
  }
);

app.post('/register',
  [
    body('username').isString().isLength({ min: 2, max: 50 }).custom(isSafeString).trim(),
    body('password').isString().isLength({ min: 6, max: 100 }),
    body('email').isEmail().normalizeEmail(),
    body('nickname').isString().isLength({ min: 1, max: 30 }).custom(isSafeString).trim(),
    body('age').isString().isLength({ min: 1, max: 10 }).custom(isSafeString)
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    const username = sanitizeText(req.body.username);
    const email = sanitizeText(req.body.email);
    const nickname = sanitizeText(req.body.nickname);
    const age = sanitizeText(req.body.age);

    const result = await db.collection('users').findOne({ username });
    if (!result) {
      const hash = await bcrypt.hash(req.body.password, 10);
      await db.collection('users').insertOne({
        username,
        password: hash,
        email,
        nickname,
        age,
        provider: 'local',
        profileImage: 'https://pixabay.com/get/ga7b56f8d85142ef1b6d2b1b493af4566af98abb61223de4dd985776273fda7a17798881dd34f18756bf56b5d87dbde70_640.png',
      });
    } else {
      res.send('이미 존재하는 아이디입니다.');
      return;
    }
    res.redirect('/');
  })
);

app.get('/auth/naver', passport.authenticate('naver', { authType: 'reprompt' }));
app.get('/callback/naver', passport.authenticate('naver', { failureRedirect: '/login' }), (req, res) => {
  res.redirect('/naver/next');
});
app.get('/naver/next', (req, res) => {
  res.redirect('/');
});

app.get('/dashboard', asyncHandler(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const userId = req.user._id;
  const userdata = await db.collection('userdata').findOne({ userId: userId });
  const showCancerPopup = !userdata; // 정보 없으면 true

  res.render('dashboard', {
    user: req.user,
    showCancerPopup
  });
}));

app.get('/cancer-info', asyncHandler(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const userId = req.user._id;
  const userdata = await db.collection('userdata').findOne({ userId: userId });
  if (userdata) return res.redirect('/dashboard');
  res.render('cancer-info.ejs', { user: req.user });
}));

app.get('/cancer-info/confirm',
  [
    query('cancer').isString().isLength({ min: 1, max: 50 }).custom(isSafeString),
    query('stage').isIn(stageTypes),
    query('susul').isIn(susulTypes),
    query('hangam').isIn(hangamTypes),
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    if (!req.user) return res.redirect('/login');
    const userId = req.user._id;
    const userdata = await db.collection('userdata').findOne({ userId: userId });
    if (userdata) return res.redirect('/dashboard');

    const cancer = sanitizeText(req.query.cancer);
    const stage = req.query.stage;
    const operation = req.query.susul;
    const hangam = req.query.hangam;

    await db.collection('userdata').insertOne({
      userId: userId,
      cancer,
      stage,
      operation,
      hangam
    });
    res.redirect('/dashboard');
  })
);

app.get('/record/meal', asyncHandler(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const userId = req.user._id;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const records = await db.collection('mealRecords').find({
    userId: userId,
    date: { $gte: todayStart, $lte: todayEnd }
  }).toArray();

  const kcalByMeal = {};
  for (const r of records) {
    kcalByMeal[r.mealType] = r.totalKcal;
  }

  const recentMealRecords = await db.collection('mealRecords')
    .find({ userId: userId })
    .sort({ date: -1 })
    .limit(200)
    .toArray();

  const dailyTotals = new Map();
  for (const r of recentMealRecords) {
    const key = new Date(r.date).toISOString().slice(0, 10);
    const prev = dailyTotals.get(key) || 0;
    dailyTotals.set(key, prev + (r.totalKcal || 0));
  }

  const sortedDays = Array.from(dailyTotals.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-7);

  const mealChart = {
    labels: sortedDays.map(([day]) => day),
    values: sortedDays.map(([, total]) => total)
  };

  res.render('meal.ejs', {
    user: req.user,
    kcalByMeal,
    mealChart
  });
}));

app.get('/meal/:mealType',
  [
    param('mealType').isIn(mealTypes),
    query('korean').optional().isString().isLength({ min: 1, max: 20 }).custom(isSafeString)
  ],
  handleValidation,
  (req, res) => {
    if (!req.user) return res.redirect('/login');
    const mealType = req.params.mealType;
    const mealTypeName = decodeURIComponent(req.query.korean || '');
    res.render('meal-input.ejs', { mealType, mealTypeName });
  }
);

app.get('/api/food',
  [
    // 외부 API 입력값 화이트리스트/길이 제한
    query('k').isString().isLength({ min: 1, max: 30 }).matches(/^[a-zA-Z0-9가-힣\s]+$/).trim()
  ],
  handleFoodApiValidation,
  asyncHandler(async (req, res) => {
    try {
      const q = req.query.k;
      const apiKey = process.env.FOOD_API_KEY;
      const url = `https://apis.data.go.kr/1471000/FoodNtrCpntDbInfo02/getFoodNtrCpntDbInq02` +
        `?serviceKey=${apiKey}` +
        '&numOfRows=100' +
        `&type=json` +
        `&FOOD_NM_KR=${encodeURIComponent(q)}`;

      const response = await fetch(url);
      const data = await response.json();
      const json = data.body.items.map(item => {
        return {
          name: item.FOOD_NM_KR,
          kcal: parseInt(item.AMT_NUM1, 10),
          serve: item.SERVING_SIZE ? Number(item.SERVING_SIZE.replace('g', '')) : null
        };
      });
      res.json(json);
    } catch (err) {
      res.status(500).json({ error: '식약처 API 요청 오류' });
    }
  })
);

app.post('/record/meal/:mealType',
  [
    param('mealType').isIn(mealTypes),
    body('items').isString().isLength({ min: 2, max: 5000 })
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    if (!req.user) return res.redirect('/login');
    const userId = req.user._id;
    const mealType = req.params.mealType;
    const itemsRaw = req.body.items;

    let items;
    try {
      items = JSON.parse(itemsRaw);
    } catch (err) {
      return res.status(400).render('400.ejs');
    }
    if (!Array.isArray(items)) return res.status(400).render('400.ejs');
    const safeItems = items.map((item) => ({
      name: typeof item.name === 'string' ? item.name.slice(0, 50) : '',
      kcal: Number(item.kcal) || 0,
      weight: Number(item.weight) || 0
    }));
    const totalKcal = safeItems.reduce((sum, item) => sum + (item.kcal || 0), 0);

    const record = {
      userId: userId,
      mealType: mealType,
      items: safeItems,
      totalKcal: totalKcal,
      date: new Date(),
    };

    await db.collection('mealRecords').insertOne(record);
    res.redirect('/dashboard');
  })
);

app.get('/record/exercise', requireLogin, asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const recent = await getRecentRecords('exerciseRecords', userId);
  const chart = {
    labels: recent.map(r => r.date),
    values: recent.map(r => r.duration || 0)
  };
  res.render('exercise.ejs', { user: req.user, chart });
}));

app.get('/record/bowel', requireLogin, asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const recent = await getRecentRecords('bowelRecords', userId);
  const chart = {
    labels: recent.map(r => r.date),
    values: recent.map(r => r.count || 0)
  };
  res.render('bowel.ejs', { user: req.user, chart });
}));

app.get('/record/temp', requireLogin, asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const recent = await getRecentRecords('tempRecords', userId);
  const chart = {
    labels: recent.map(r => r.date),
    values: recent.map(r => r.temperature || 0)
  };
  res.render('temp.ejs', { user: req.user, chart });
}));

app.get('/record/pressure', requireLogin, asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const recent = await getRecentRecords('pressureRecords', userId);
  const chart = {
    labels: recent.map(r => r.date),
    systolic: recent.map(r => r.systolic || 0),
    diastolic: recent.map(r => r.diastolic || 0)
  };
  res.render('pressure.ejs', { user: req.user, chart });
}));

app.get('/record/weight', requireLogin, asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const recent = await getRecentRecords('weightRecords', userId);
  const chart = {
    labels: recent.map(r => r.date),
    values: recent.map(r => r.weight || 0)
  };
  res.render('weight.ejs', { user: req.user, chart });
}));

app.get('/record/mood', requireLogin, asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const recent = await getRecentRecords('moodRecords', userId);
  const chart = {
    labels: recent.map(r => r.date),
    values: recent.map(r => moodToScore(r.mood))
  };
  res.render('mood.ejs', { user: req.user, chart });
}));

app.get('/record/pain', requireLogin, asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const recent = await getRecentRecords('painRecords', userId);
  const chart = {
    labels: recent.map(r => r.date),
    values: recent.map(r => r.level || 0)
  };
  res.render('pain.ejs', { user: req.user, chart });
}));

app.get('/record/water', requireLogin, asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const recent = await getRecentRecords('waterRecords', userId);
  const chart = {
    labels: recent.map(r => r.date),
    values: recent.map(r => r.amount || 0)
  };
  res.render('water.ejs', { user: req.user, chart });
}));

app.post('/record/exercise',
  [
    body('type').isString().isLength({ min: 1, max: 30 }).custom(isSafeString).trim(),
    body('duration').isInt({ min: 0, max: 600 }).toInt(),
    body('intensity').isIn(intensityTypes),
    body('memo').optional({ checkFalsy: true }).isString().isLength({ max: 200 }).custom(isSafeString)
  ],
  handleValidation,
  requireLogin,
  asyncHandler(async (req, res) => {
    const userId = req.user._id;
    await db.collection('exerciseRecords').insertOne({
      userId,
      type: sanitizeText(req.body.type),
      duration: req.body.duration,
      intensity: req.body.intensity,
      memo: sanitizeText(req.body.memo || ''),
      date: new Date()
    });
    res.redirect('/record/exercise');
  })
);

app.post('/record/bowel',
  [
    body('status').isIn(bowelStatusTypes),
    body('count').isInt({ min: 0, max: 20 }).toInt(),
    body('memo').optional({ checkFalsy: true }).isString().isLength({ max: 200 }).custom(isSafeString)
  ],
  handleValidation,
  requireLogin,
  asyncHandler(async (req, res) => {
    const userId = req.user._id;
    await db.collection('bowelRecords').insertOne({
      userId,
      status: req.body.status,
      count: req.body.count,
      memo: sanitizeText(req.body.memo || ''),
      date: new Date()
    });
    res.redirect('/record/bowel');
  })
);

app.post('/record/temp',
  [
    body('temperature').isFloat({ min: 30, max: 45 }).toFloat(),
    body('memo').optional({ checkFalsy: true }).isString().isLength({ max: 200 }).custom(isSafeString)
  ],
  handleValidation,
  requireLogin,
  asyncHandler(async (req, res) => {
    const userId = req.user._id;
    await db.collection('tempRecords').insertOne({
      userId,
      temperature: req.body.temperature,
      memo: sanitizeText(req.body.memo || ''),
      date: new Date()
    });
    res.redirect('/record/temp');
  })
);

app.post('/record/pressure',
  [
    body('systolic').isInt({ min: 50, max: 250 }).toInt(),
    body('diastolic').isInt({ min: 30, max: 150 }).toInt(),
    body('glucose').optional({ checkFalsy: true }).isInt({ min: 30, max: 400 }).toInt(),
    body('memo').optional({ checkFalsy: true }).isString().isLength({ max: 200 }).custom(isSafeString)
  ],
  handleValidation,
  requireLogin,
  asyncHandler(async (req, res) => {
    const userId = req.user._id;
    await db.collection('pressureRecords').insertOne({
      userId,
      systolic: req.body.systolic,
      diastolic: req.body.diastolic,
      glucose: req.body.glucose || null,
      memo: sanitizeText(req.body.memo || ''),
      date: new Date()
    });
    res.redirect('/record/pressure');
  })
);

app.post('/record/weight',
  [
    body('weight').isFloat({ min: 0, max: 300 }).toFloat(),
    body('bodyFat').optional({ checkFalsy: true }).isFloat({ min: 0, max: 80 }).toFloat(),
    body('memo').optional({ checkFalsy: true }).isString().isLength({ max: 200 }).custom(isSafeString)
  ],
  handleValidation,
  requireLogin,
  asyncHandler(async (req, res) => {
    const userId = req.user._id;
    await db.collection('weightRecords').insertOne({
      userId,
      weight: req.body.weight,
      bodyFat: req.body.bodyFat || null,
      memo: sanitizeText(req.body.memo || ''),
      date: new Date()
    });
    res.redirect('/record/weight');
  })
);

app.post('/record/mood',
  [
    body('mood').isIn(moodTypes),
    body('energy').isIn(energyTypes),
    body('memo').optional({ checkFalsy: true }).isString().isLength({ max: 200 }).custom(isSafeString)
  ],
  handleValidation,
  requireLogin,
  asyncHandler(async (req, res) => {
    const userId = req.user._id;
    await db.collection('moodRecords').insertOne({
      userId,
      mood: req.body.mood,
      energy: req.body.energy,
      memo: sanitizeText(req.body.memo || ''),
      date: new Date()
    });
    res.redirect('/record/mood');
  })
);

app.post('/record/pain',
  [
    body('level').isInt({ min: 0, max: 10 }).toInt(),
    body('location').isString().isLength({ min: 1, max: 30 }).custom(isSafeString).trim(),
    body('memo').optional({ checkFalsy: true }).isString().isLength({ max: 200 }).custom(isSafeString)
  ],
  handleValidation,
  requireLogin,
  asyncHandler(async (req, res) => {
    const userId = req.user._id;
    await db.collection('painRecords').insertOne({
      userId,
      level: req.body.level,
      location: sanitizeText(req.body.location),
      memo: sanitizeText(req.body.memo || ''),
      date: new Date()
    });
    res.redirect('/record/pain');
  })
);

app.post('/record/water',
  [
    body('amount').isInt({ min: 0, max: 10000 }).toInt(),
    body('memo').optional({ checkFalsy: true }).isString().isLength({ max: 200 }).custom(isSafeString)
  ],
  handleValidation,
  requireLogin,
  asyncHandler(async (req, res) => {
    const userId = req.user._id;
    await db.collection('waterRecords').insertOne({
      userId,
      amount: req.body.amount,
      memo: sanitizeText(req.body.memo || ''),
      date: new Date()
    });
    res.redirect('/record/water');
  })
);

app.get('/123', (req, res, next) => {
  const err = new Error('123');
  err.statusCode = 429;
  next(err);
});

// CSRF 에러 처리
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).render('403.ejs');
  }
  next(err);
});

// 공통 에러 처리
app.use((err, req, res, next) => {
  const status = err.statusCode || 500;
  if (status === 400) return res.status(400).render('400.ejs');
  if (status === 401) return res.status(401).render('401.ejs');
  if (status === 403) return res.status(403).render('403.ejs');
  if (status === 429) return res.status(429).render('429.ejs');
  if (status >= 400 && status < 500) return res.status(status).render('4xx.ejs');
  return res.status(500).render('500.ejs');
});

app.use((req, res) => {
  res.status(404).render('404.ejs');
});
