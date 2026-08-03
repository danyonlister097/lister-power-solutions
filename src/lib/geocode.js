const https = require('https');
const config = require('../config');

async function geocodeAddress(address) {
  const apiKey = config.maps.apiKey;
  if (!apiKey) return null;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}&region=au`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'OK' && json.results.length > 0) {
            const loc = json.results[0].geometry.location;
            resolve({ lat: loc.lat, lng: loc.lng });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

function buildAddress(customer) {
  return [customer.address_street, customer.address_city, customer.address_state, customer.address_postcode, 'Australia']
    .filter(Boolean)
    .join(', ');
}

module.exports = { geocodeAddress, buildAddress };
