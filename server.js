const express = require('express');
const ejs = require('ejs');
const app = express();
const port = 3000;

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');

app.use(express.static(__dirname + '/public'));
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/welcome.html');
});

app.get('/next', (req, res) => {
    const sickCode = req.query.Code;
    const sickName = req.query.Name;
    res.render('next.ejs', { Code : sickCode, Name : sickName });
});

app.get('/home', (req, res) => {
    res.send("OK")
});