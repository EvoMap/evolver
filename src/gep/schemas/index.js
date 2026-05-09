'use strict';

const gene = require('./gene');
const capsule = require('./capsule');
const task = require('./task');

module.exports = { ...gene, ...capsule, ...task };
