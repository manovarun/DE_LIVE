const createError = require('http-errors');
const express = require('express');
const path = require('path');
const dotenv = require('dotenv').config({ path: '.env' });
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const GlobalErrorHandler = require('./controllers/ErrorController');
const connectDB = require('./db');

connectDB();

const indexRouter = require('./routes/index');
const swingRouter = require('./routes/swing');
const socketRouter = require('./routes/socket');
const optionsRouter = require('./routes/options');
const futureRouter = require('./routes/future');
const backtestRouter = require('./routes/backtest');

const app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/api/swing', swingRouter);
app.use('/api/socket', socketRouter);
app.use('/api/options', optionsRouter);
app.use('/api/future', futureRouter);
app.use('/api/backtest', backtestRouter);

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
