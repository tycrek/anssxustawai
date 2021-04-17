const fs = require('fs-extra');
const Path = require('path');
const token = require('./generators/token');
const zwsGen = require('./generators/zws');
const randomGen = require('./generators/random');

const idModes = {
	zws: 'zws',     // Zero-width spaces (see: https://zws.im/)
	og: 'original', // Use original uploaded filename
	r: 'random'     // Use a randomly generated ID with a mixed-case alphanumeric character set
	// todo: gfycat-style ID's (example.com/correct-horse-battery-staple)
};

module.exports = {
	log: console.log,
	path: (...paths) => Path.join(__dirname, ...paths),
	saveData: (data) => fs.writeJsonSync(Path.join(__dirname, '..', 'data.json'), data, { spaces: 4 }),
	verify: (req, tokens) => req.headers.authorization && tokens.includes(req.headers.authorization),
	generateToken: () => token(),
	generateId: (mode, lenth, originalName) =>
		(mode == idModes.zws) ? zwsGen(lenth)
			: (mode == idModes.r) ? randomGen(lenth)
				: originalName,
	formatBytes: (bytes, decimals = 2) => {
		if (bytes === 0) return '0 Bytes';
		let sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
		let i = Math.floor(Math.log(bytes) / Math.log(1024));
		return parseFloat((bytes / Math.pow(1024, i)).toFixed(decimals < 0 ? 0 : decimals)) + ' ' + sizes[i];
	},
	randomHexColour: () => { // From: https://www.geeksforgeeks.org/javascript-generate-random-hex-codes-color/
		let letters = "0123456789ABCDEF";
		let colour = '#';
		for (var i = 0; i < 6; i++) colour += letters[(Math.floor(Math.random() * 16))];
		return colour;
	}
}
