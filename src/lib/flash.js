function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

module.exports = { setFlash };
