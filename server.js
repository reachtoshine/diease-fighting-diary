const express = require('express');
const ejs = require('ejs');
const app = express();
const port = 3000;
const { MongoClient } = require('mongodb')
const session = require('express-session')
const passport = require('passport')
const LocalStrategy = require('passport-local')
const bcrypt = require('bcrypt');
const MongoStore = require('connect-mongo');
const { ObjectId } = require('mongodb');
const NaverStrategy = require('passport-naver').Strategy;
const fetch = require('node-fetch');
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
  console.log(profile);
  const userData = {
    username: profile.id,
    name: profile._json.name,
    email: profile._json.email,
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
  if (result.password) {
    delete result.password
  }
  process.nextTick(() => {
    return done(null, result)
  })
})

let db
const url = process.env.MONGODB_URI
new MongoClient(url).connect().then((client)=>{
  console.log('DB연결성공')
  db = client.db('CancerDiary')

  app.listen(port, () => {
    console.log('Server is running on http://localhost:' + port);
  })

}).catch((err)=>{
  console.log(err)
})

app.get('/', (req, res) => {
    
    res.redirect('/home');
});

app.get('/next', (req, res) => {
    const sickCode = req.query.Code;
    const sickName = req.query.Name;
    res.render('next.ejs', { Code : sickCode, Name : sickName });
});

app.get('/home', (req, res) => {
    if (req.user) {
        res.send('OK')
    }
 else {
        res.redirect('/login');
    }
});

app.get('/login', (req, res) => {
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
      name : req.body.name,
      birthday : req.body.birth ,
    })
  } else {
    res.send('이미 존재하는 아이디입니다.')
  }
  res.redirect('/')
})

app.get('/callback/naver',
  passport.authenticate('naver', { failureRedirect: '/' }),
  (req, res) => {
    res.redirect('/');
  }
);