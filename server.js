const express = require('express');
const app = express();
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
const port = Number(process.env.PORT) || 4000;
const { mealWindow, summarizeMeals, parseMealItems } = require('./lib/meal-records');

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');

// Render 등 프록시 환경에서 secure 쿠키/CSRF 정상 동작을 위해 신뢰 설정
app.set('trust proxy', true);

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

// GET 검색은 그대로 허용하고, 상태를 바꾸는 요청은 모두 보호합니다.
app.use(csrf());

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

// 로그인 입력은 사용자 경험 우선 (400 대신 로그인 오류로 처리)
const handleLoginValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.redirect('/login?error=invalid');
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
    if (typeof inputUsername !== 'string') {
      return cb(null, false, { message: 'Invalid input' });
    }
    const username = sanitizeText(inputUsername);
    const result = await db.collection('users').findOne({
      username,
      $or: [{ provider: 'local' }, { provider: { $exists: false } }]
    });
    if (!result || typeof result.password !== 'string') {
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
      providerId: profile.id,
      nickname: profile.displayName,
      email: profile._json.email,
      profileImage: profile._json.profile_image,
      age: profile._json.age,
      provider: 'naver'
    };

    const user = await db.collection('users').findOne({
      provider: 'naver',
      $or: [
        { providerId: profile.id },
        { username: profile.id, providerId: { $exists: false } }
      ]
    });
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
    } else if (typeof user.id === 'string') {
      // 오래된 세션에는 provider가 없으므로 계정이 하나일 때만 복구합니다.
      const candidates = await db.collection('users').find({ username: sanitizeText(user.id) }).limit(2).toArray();
      result = candidates.length === 1 ? candidates[0] : null;
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
  if (req.user) return res.redirect('/dashboard');
  return res.redirect('/login');
});

app.get('/next',
  [
    query('Code').optional().isString(),
    query('Name').optional().isString()
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
  [ query('error').optional().isString() ],
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
    body('username').isString().bail().trim().isLength({ min: 1, max: 50 }),
    body('password').isString().isLength({ min: 1, max: 100 })
  ],
  handleLoginValidation,
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
    body('username').isString().bail().trim().isLength({ min: 2, max: 50 }),
    body('password').isString().isLength({ min: 6, max: 100 }),
    body('confirmPassword').isString().bail().custom((value, { req }) => value === req.body.password),
    body('email').isEmail().normalizeEmail(),
    body('nickname').isString().bail().trim().isLength({ min: 1, max: 30 }),
    body('age').isString().bail().trim().isLength({ min: 1, max: 10 })
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    const username = sanitizeText(req.body.username);
    const email = sanitizeText(req.body.email);
    const nickname = sanitizeText(req.body.nickname);
    const age = sanitizeText(req.body.age);

    const result = await db.collection('users').findOne({
      username,
      $or: [{ provider: 'local' }, { provider: { $exists: false } }]
    });
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

app.get('/cancer-info/confirm', requireLogin, (req, res) => res.redirect('/cancer-info'));

app.post('/cancer-info/confirm',
  requireLogin,
  [
    body('cancer').isString().bail().trim().isLength({ min: 1, max: 50 }),
    body('stage').isIn(stageTypes),
    body('susul').isIn(susulTypes),
    body('hangam').isIn(hangamTypes),
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    if (!req.user) return res.redirect('/login');
    const userId = req.user._id;
    const userdata = await db.collection('userdata').findOne({ userId: userId });
    if (userdata) return res.redirect('/dashboard');

    const cancer = sanitizeText(req.body.cancer);
    const stage = req.body.stage;
    const operation = req.body.susul;
    const hangam = req.body.hangam;

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

app.get('/record/meal', requireLogin, asyncHandler(async (req, res) => {
  const window = mealWindow(new Date());
  const records = await db.collection('mealRecords').find({
    userId: req.user._id,
    date: { $gte: window.start, $lt: window.end }
  }, { projection: { date: 1, mealType: 1, totalKcal: 1 } }).toArray();
  res.render('meal.ejs', { user: req.user, ...summarizeMeals(records, window) });
}));

app.get('/meal/:mealType',
  [
    param('mealType').isIn(mealTypes),
    query('korean').optional().isString().bail().trim().isLength({ min: 1, max: 20 })
  ],
  handleValidation,
  (req, res) => {
    if (!req.user) return res.redirect('/login');
    const mealType = req.params.mealType;
    const mealTypeName = req.query.korean || '';
    res.render('meal-input.ejs', { mealType, mealTypeName });
  }
);

app.get('/api/food',
  [
    // 검색어는 문자열/길이를 검사하고 외부 URL에는 인코딩해서 전달합니다.
    query('k').isString().bail().trim().isLength({ min: 1, max: 30 })
  ],
  handleFoodApiValidation,
  asyncHandler(async (req, res) => {
    try {
      const q = req.query.k.trim();
      const apiKey = process.env.FOOD_API_KEY;
      const url = `https://apis.data.go.kr/1471000/FoodNtrCpntDbInfo02/getFoodNtrCpntDbInq02` +
        `?serviceKey=${apiKey}` +
        '&numOfRows=100' +
        `&type=json` +
        `&FOOD_NM_KR=${encodeURIComponent(q)}`;

      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('Food API HTTP failure');
      const data = await response.json();
      if (!data.body) throw new Error('Invalid food API response');
      const resultCode = data.header?.resultCode;
      if (resultCode != null && !['00', '0'].includes(String(resultCode))) {
        throw new Error('Food API application failure');
      }
      let items = data.body.items;
      const emptyResult = data.body.totalCount != null && String(data.body.totalCount) === '0';
      if ((items == null || items === '') && emptyResult) items = [];
      if (!Array.isArray(items)) throw new Error('Invalid food API items');
      const json = items.filter(item => item && typeof item.FOOD_NM_KR === 'string' &&
        item.AMT_NUM1 != null && String(item.AMT_NUM1).trim() !== '' &&
        Number.isFinite(Number(item.AMT_NUM1)) && Number(item.AMT_NUM1) >= 0).map(item => {
        const serving = Number(String(item.SERVING_SIZE || '').replace(/g$/i, '').trim());
        return {
          name: item.FOOD_NM_KR,
          kcal: Number(item.AMT_NUM1),
          serve: Number.isFinite(serving) && serving > 0 ? serving : null
        };
      });
      res.json(json);
    } catch (err) {
      const status = err.name === 'TimeoutError' || err.name === 'AbortError' ? 504 : 502;
      res.status(status).json({ error: '식약처 API 요청 오류' });
    }
  })
);

app.post('/record/meal/:mealType',
  [
    param('mealType').isIn(mealTypes),
    body('items').isString().bail().trim().isLength({ min: 2, max: 5000 })
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    if (!req.user) return res.redirect('/login');
    const userId = req.user._id;
    const mealType = req.params.mealType;
    const itemsRaw = req.body.items;

    let safeItems;
    try {
      safeItems = parseMealItems(itemsRaw);
    } catch (err) {
      return res.status(400).render('400.ejs');
    }
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

const recordCharts = [
  { type: 'exercise', values: { values: r => r.duration || 0 } },
  { type: 'bowel', values: { values: r => r.count || 0 } },
  { type: 'temp', values: { values: r => r.temperature || 0 } },
  { type: 'pressure', values: { systolic: r => r.systolic || 0, diastolic: r => r.diastolic || 0 } },
  { type: 'weight', values: { values: r => r.weight || 0 } },
  { type: 'mood', values: { values: r => moodToScore(r.mood) } },
  { type: 'pain', values: { values: r => r.level || 0 } },
  { type: 'water', values: { values: r => r.amount || 0 } }
];

for (const { type, values } of recordCharts) {
  app.get(`/record/${type}`, requireLogin, asyncHandler(async (req, res) => {
    const recent = await getRecentRecords(`${type}Records`, req.user._id);
    const chart = { labels: recent.map(r => r.date) };
    for (const [key, select] of Object.entries(values)) chart[key] = recent.map(select);
    res.render(`${type}.ejs`, { user: req.user, chart });
  }));
}

const memoValidation = () => body('memo').optional({ checkFalsy: true }).isString().bail().trim().isLength({ max: 200 });

app.post('/record/exercise',
  [
    body('type').isString().bail().trim().isLength({ min: 1, max: 30 }),
    body('duration').isInt({ min: 0, max: 600 }).toInt(),
    body('intensity').isIn(intensityTypes),
    memoValidation()
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
    memoValidation()
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
    memoValidation()
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
    memoValidation()
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
    memoValidation()
  ],
  handleValidation,
  requireLogin,
  asyncHandler(async (req, res) => {
    const userId = req.user._id;
    await db.collection('weightRecords').insertOne({
      userId,
      weight: req.body.weight,
      bodyFat: req.body.bodyFat === '' ? null : (req.body.bodyFat ?? null),
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
    memoValidation()
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
    body('location').isString().bail().trim().isLength({ min: 1, max: 30 }),
    memoValidation()
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
    memoValidation()
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
  if (status >= 400 && status < 500) return res.status(status).render('400.ejs');
  return res.status(500).render('500.ejs');
});

app.use((req, res) => {
  res.status(404).render('404.ejs');
});

