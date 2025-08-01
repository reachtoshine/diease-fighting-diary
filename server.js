const express = require('express');
const ejs = require('ejs');
const app = express();
const port = 4000;
const { MongoClient } = require('mongodb')
const session = require('express-session')
const passport = require('passport')
const LocalStrategy = require('passport-local')
const bcrypt = require('bcrypt');
const MongoStore = require('connect-mongo');
const { ObjectId } = require('mongodb');
const NaverStrategy = require('passport-naver').Strategy;
const xml2js = require('xml2js');
const dotenv = require('dotenv');
dotenv.config();

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');

app.use(express.static(__dirname + '/public'));
app.use(passport.initialize())
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave : false,
  saveUninitialized : false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 365},
  store: MongoStore.create({
    mongoUrl : process.env.MONGODB_URI,
    dbName: 'CancerDiary',
  })
}))
app.use(passport.session()) 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

passport.use(new LocalStrategy(async (입력한아이디, 입력한비번, cb) => {
  let result = await db.collection('users').findOne({ username : 입력한아이디})
  if (!result) {
    return cb(null, false, { message: '아이디 DB에 없음' })
  }
  if (await bcrypt.compare(입력한비번, result.password)) {
    return cb(null, result)
  } else {
    return cb(null, false, { message: '비번불일치' });
  }
}))

passport.use(new NaverStrategy({
  clientID: process.env.NAVER_CLIENT_ID,
  clientSecret: process.env.NAVER_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
  console.log("this is profile" + JSON.stringify(profile));
  const userData = {
    username: profile.id,
    nickname: profile.displayName,
    email: profile._json.email,
    profileImage: profile._json.profile_image,
    age: profile._json.age,
    provider: 'naver'
  };

  try {
    let user = await db.collection('users').findOne({ username: userData.username });
    if (!user) {
      // 새 유저면 DB에 저장
      await db.collection('users').insertOne(userData);
      console.log(userData)
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
  let result = await db.collection('users').findOne({_id : new ObjectId(user.id) })
  process.nextTick(() => {
    return done(null, result)
  })
})

let db
const url = process.env.MONGODB_URI
new MongoClient(url).connect().then((client)=>{
  console.log('DB연결성공')
  db = client.db('CancerDiary')

  app.listen(port,'0.0.0.0' ,() => {
    console.log('Server is running on http://localhost:' + port);
  })

}).catch((err)=>{
  console.log(err)
})


app.get('/', (req, res) => {
    if (req.user) {
        res.redirect('/home');
    } else {
        res.redirect('/login');
    }
});

app.get('/next', (req, res) => {
    const sickCode = req.query.Code;
    const sickName = req.query.Name;
    res.render('next.ejs', { Code : sickCode, Name : sickName });
});

app.get('/home', (req, res) => {
    if (req.user) {
        console.log(req.user)
        res.redirect('/dashboard');
    }
 else {
        res.redirect('/login');
    }
});

app.get('/login', (req, res) => {
    if(req.user) {
        return res.redirect('/dashboard');
    }
    res.render('login.ejs');
}); 

app.get('/register', (req, res) => {
    res.render('register.ejs');
});
app.get('/forgot-password', (req, res) => {
    res.render('forgot-password.ejs');
});

app.post('/login', async (req, res, next) => {

  passport.authenticate('local', (error, user, info) => {
      if (error) return res.status(500).json(error)
      if (!user) return res.status(401).json(info.message)
      req.logIn(user, (err) => {
        if (err) return next(err)
        res.redirect('/')
      })
  })(req, res, next)

}) 

app.post('/register', async (req, res) => {
  let result = await db.collection('users').findOne({ username : req.body.username })
  if (!result){
    let hash = await bcrypt.hash(req.body.password, 10) 
    console.log(req.body)
    await db.collection('users').insertOne({
      username : req.body.username,
      password : hash,
      email : req.body.email,
      nickname : req.body.nickname,
      age : req.body.age,
      provider : 'local',
      profileImage : 'https://pixabay.com/get/ga7b56f8d85142ef1b6d2b1b493af4566af98abb61223de4dd985776273fda7a17798881dd34f18756bf56b5d87dbde70_640.png',
    })
  } else {
    res.send('이미 존재하는 아이디입니다.')
  }
  res.redirect('/')
})

app.get('/auth/naver', passport.authenticate('naver', {authType: 'reprompt'}));
app.get('/callback/naver', passport.authenticate('naver', { failureRedirect: '/login' }), (req, res) => {
  res.redirect('/naver/next');
});

app.get('/naver/next', (req, res) => {
  res.redirect('/');
});

app.get('/dashboard', async (req, res) => {
  if (!req.user) {
    return res.redirect('/login');
  } else {
      const userId = req.user._id;

  const userdata = await db.collection('userdata').findOne({ userId: userId });

  const showCancerPopup = !userdata; // 정보 없으면 true

  res.render('dashboard', {
    user: req.user,
    showCancerPopup
  });
  }
});

app.get('/cancer-info', async (req, res) => {
  if (!req.user) {
    return res.redirect('/login');
  }
  const userId = req.user._id;
  const userdata = await db.collection('userdata').findOne({ userId: userId });
  if (userdata) {
    return res.redirect('/dashboard');
  } else{
    res.render('cancer-info.ejs', {
      user: req.user
    });
  }
});

app.get('/cancer-info/confirm', async (req, res) => {
  if (!req.user) {
    return res.redirect('/login');
  }
  const userId = req.user._id;
  const userdata = await db.collection('userdata').findOne({ userId: userId });
  if (userdata) {
    return res.redirect('/dashboard');
  } else{
    let cancer = req.query.cancer;
    let stage = req.query.stage;
    let operation = req.query.susul;
    let hangam = req.query.hangam;

    await db.collection('userdata').insertOne({
      userId: userId,
      cancer: cancer,
      stage: stage,
      operation: operation,
      hangam: hangam});
    res.redirect('/dashboard');
  }
});

app.get('/record/meal', async (req, res) => {
  if (!req.user) {
    return res.redirect('/login');
  } else {
    const userId = req.user._id;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    try {
      const records = await db.collection('mealRecords').find({
        userId: userId,
        date: { $gte: todayStart, $lte: todayEnd }
    }).toArray();

    // 끼니별 칼로리 정리
    const kcalByMeal = {};
    for (const r of records) {
      kcalByMeal[r.mealType] = r.totalKcal;
    }

    res.render('meal.ejs', {
      user: req.user,
      kcalByMeal // { breakfast: 320, lunch: null, ... }
    });
  } catch (err) {
    console.error('식사 데이터 조회 실패:', err);
    res.status(500).send('서버 오류');
  };
}});

app.get('/meal/:mealType', (req, res) => {
  if (!req.user) {
    return res.redirect('/login');
  }
  const mealType = req.params.mealType;
  const mealTypeName = decodeURIComponent(req.query.korean)

  res.render('meal-input.ejs', { mealType, mealTypeName });

});

app.get('/api/food', async (req, res) => {
  const q = req.query.k;
  if (!q) return res.status(400).json({ error: '음식 이름이 필요합니다.' });

  const apiKey = process.env.FOOD_API_KEY;
  const url = `https://apis.data.go.kr/1471000/FoodNtrCpntDbInfo02/getFoodNtrCpntDbInq02` +
    `?serviceKey=${apiKey}` +
    '&numOfRows=100'+
    `&type=json` +
    `&FOOD_NM_KR=${encodeURIComponent(q)}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
let json = data.body.items.map(item => {
  return {
    name: item.FOOD_NM_KR,
    kcal: parseInt(item.AMT_NUM1),
    serve: item.SERVING_SIZE ? Number(item.SERVING_SIZE.replace("g", "")) : null
  };
});


    res.json(json);
  } catch (err) {
    console.error('API 요청 실패:', err);
    res.status(500).json({ error: '식약처 API 요청 오류' });
  }
});

app.post('/record/meal/:mealType', async (req, res) => {
  if (!req.user) {
    res.redirect('/login');
  }

  const userId = req.user._id;
  const mealType = req.params.mealType;
  const itemsRaw = req.body.items;

  let items;
  try {
    items = JSON.parse(itemsRaw);
  } catch (err) {
    return res.status(400).send('입력 데이터 오류');
  }
  const totalKcal = items.reduce((sum, item) => sum + (item.kcal || 0), 0);
  
  const record = {
    userId: userId,
    mealType: mealType,
    items: items, // [{name, kcal, weight}]
    totalKcal: totalKcal, // 총 칼로리
    date: new Date(), // 기록 시각
  };

  try {
    const result = await db.collection('mealRecords').insertOne(record);
    console.log('기록 성공:', result.insertedId);
    res.redirect('/dashboard'); // 성공 시 대시보드 등으로 이동
  } catch (err) {
    console.error('DB 저장 실패:', err);
    res.status(500).send('서버 오류로 저장 실패');
  }
});






app.get('/123', (req, res, next) => {
  const err = new Error('123');
  err.statusCode = 429;
  next(err);
});



















// app.use((err, req, res, next) => {
//   const status = err.statusCode || 500;

//   if (status === 400) return res.status(400).render('400.ejs');
//   if (status === 401) return res.status(401).render('401.ejs');
//   if (status === 403) return res.status(403).render('403.ejs');
//   if (status === 429) return res.status(429).render('429.ejs');

//   // 그 외 4xx는 공통 처리
//   if (status >= 400 && status < 500) {
//     return res.status(status).render('4xx.ejs');
//   }

//   next(err); // 서버 에러(500번대)는 다음 핸들러로
// });


// app.use((err, req, res, next) => {
//   res.status(500).render('500.ejs');
// });

// app.use((req, res, next) => {
//   res.status(404).render('404.ejs');
// });