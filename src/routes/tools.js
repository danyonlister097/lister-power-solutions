const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('tools/index', { title: 'Tools' });
});

router.get('/cable-sizing', (req, res) => {
  res.render('tools/cable-sizing', { title: 'Cable Sizing Calculator' });
});

router.get('/voltage-drop', (req, res) => {
  res.render('tools/voltage-drop', { title: 'Voltage Drop Calculator' });
});

router.get('/conduit-sizing', (req, res) => {
  res.render('tools/conduit-sizing', { title: 'Conduit Sizing Calculator' });
});

router.get('/breaker-sizing', (req, res) => {
  res.render('tools/breaker-sizing', { title: 'Circuit Breaker Sizing Calculator' });
});

router.get('/max-demand', (req, res) => {
  res.render('tools/max-demand', { title: 'Maximum Demand Calculator' });
});

module.exports = router;
