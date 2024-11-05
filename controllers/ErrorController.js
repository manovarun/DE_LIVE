const AppError = require('../utils/AppError');

const GlobalErrorHandler = (err, req, res, next) => {
  let error = { ...err };
  console.log(error);
  error.statusCode = err.statusCode || 500;
  error.status = err.status || 'error';
  error.name = err.name;
  error.message = err.message;
  error.stack = err.stack;

  if (error.name === 'CastError') {
    const message = `Invalid ${err.path}:${err.value}`;
    error = new AppError(message, 400);
  }

  if (error.name === 11000) {
    const message = `Duplicate field value: ${Object.values(
      err.keyValue[0]
    )}. Please use another value!`;
    error = new AppError(message, 400);
  }

  if (error.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((el) => el.message);
    const message = `Invalid input data. ${errors.join('. ')}`;
    error = new AppError(message, 400);
  }

  if (error.name === 'JsonWebTokenError') {
    const message = 'Invalid token. Please log in again';
    error = new AppError(message, 401);
  }

  if (error.name === 'TokenExpiredError') {
    error = new AppError('Your token has expired! Please log in again', 401);
  }

  res.status(error.statusCode).json({
    status: error.status,
    message: error.message,
    name: error.name,
    stack: error.stack,
  });
};

module.exports = GlobalErrorHandler;
