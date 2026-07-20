// Express 4 doesn't catch a rejected promise from an async handler on its
// own - wrapping every route/middleware function in this forwards any
// thrown/rejected error to next(), so the existing error-handling
// middleware in app.js keeps working unchanged now that db calls are async.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
