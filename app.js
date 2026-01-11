const createError = require('http-errors');
const express = require('express');
const path = require('path');
const dotenv = require('dotenv').config({ path: '.env' });
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const GlobalErrorHandler = require('./controllers/ErrorController');
const connectDB = require('./db');

const dbReadyPromise = Promise.resolve(connectDB());

const tickerRouter = require('./routes/backtest');
const {
  startSuperTrendBearCallSpreadPaperTradeBTCron,
} = require('./controllers/SuperTrendBearCallSpreadPaperTradeBTCController');

const app = express();

// Start cron ONLY after Mongo is connected (connectDB() is async; without await you can race).
dbReadyPromise
  .then(() => {
    startSuperTrendBearCallSpreadPaperTradeBTCron();
  })
  .catch((e) => {
    console.error(
      '[BOOT] MongoDB connection failed. Paper cron not started.',
      e
    );
  });

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/backtest', tickerRouter);

app.use(GlobalErrorHandler);

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
