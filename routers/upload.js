const fs = require('fs-extra');
const bb = require('express-busboy');
//const rateLimit = require('express-rate-limit');
const { DateTime } = require('luxon');
const { Webhook, MessageBuilder } = require('discord-webhook-node');
const { processUploaded } = require('../storage');
const { maxUploadSize, resourceIdSize, gfyIdSize, resourceIdType, spaceReplace } = require('../config.json');
const { path, log, verify, getTrueHttp, getTrueDomain, generateId, formatBytes } = require('../utils');
const { CODE_UNAUTHORIZED, CODE_PAYLOAD_TOO_LARGE } = require('../MagicNumbers.json');
const data = require('../data');
const users = require('../auth');

const ASS_LOGO = 'https://cdn.discordapp.com/icons/848274994375294986/8d339d4a2f3f54b2295e5e0ff62bd9e6.png?size=1024';
const express = require('express');
const router = express.Router();

// Set up express-busboy
// todo: re-do file size restrictions & mimetypes
bb.extend(router, {
	upload: true,
	restrictMultiple: true,
	allowedPath: (url) => url === '/',
});

// Rate limit middleware
/* router.use('/', rateLimit({
	windowMs: 1000 * 60, // 60 seconds // skipcq: JS-0074
	max: 90 // Limit each IP to 30 requests per windowMs // skipcq: JS-0074
})); */

// Block unauthorized requests and attempt token sanitization
router.post('/', (req, res, next) => {
	req.headers.authorization = req.headers.authorization || '';
	req.token = req.headers.authorization.replace(/[^\da-z]/gi, ''); // Strip anything that isn't a digit or ASCII letter
	!verify(req, users) ? log.warn('Upload blocked', 'Unauthorized').callback(() => res.sendStatus(CODE_UNAUTHORIZED)) : next(); // skipcq: JS-0093
});

// Upload file
router.post('/', processUploaded);

// todo: remove this (old Multer file size error handling)
router.use('/', (err, _req, res, next) => err.code && err.code === 'LIMIT_FILE_SIZE' ? log.warn('Upload blocked', 'File too large').callback(() => res.status(CODE_PAYLOAD_TOO_LARGE).send(`Max upload size: ${maxUploadSize}MB`)) : next(err)); // skipcq: JS-0229

// Process uploaded file
router.post('/', (req, res, next) => {
	// Load overrides
	const trueDomain = getTrueDomain(req.headers['x-ass-domain']);
	const generator = req.headers['x-ass-access'] || resourceIdType;

	// Save domain with file
	req.file.domain = `${getTrueHttp()}${trueDomain}`;

	// Get the uploaded time in milliseconds
	req.file.timestamp = DateTime.now().toMillis();

	// Save the timezone offset
	req.file.timeoffset = req.headers['x-ass-timeoffset'] || 'UTC+0';

	// Keep track of the token that uploaded the resource
	req.file.token = req.token;

	// Attach any embed overrides, if necessary
	req.file.opengraph = {
		title: req.headers['x-ass-og-title'],
		description: req.headers['x-ass-og-description'],
		author: req.headers['x-ass-og-author'],
		authorUrl: req.headers['x-ass-og-author-url'],
		provider: req.headers['x-ass-og-provider'],
		providerUrl: req.headers['x-ass-og-provider-url'],
		color: req.headers['x-ass-og-color']
	};

	// Fix spaces in originalname
	req.file.originalname = req.file.originalname.replace(/\s/g, spaceReplace === '!' ? '' : spaceReplace);

	// Generate a unique resource ID
	let resourceId = '';

	// Function to call to generate a fresh ID. Used for multiple attempts in case an ID is already taken
	const gen = () => generateId(generator, resourceIdSize, req.headers['x-ass-gfycat'] || gfyIdSize, req.file.originalname);

	// Keeps track of the number of attempts in case all ID's are taken
	const attempts = {
		count: 0,
		max: 50
	};

	// Called by a promise, this will recursively resolve itself until a unique ID is found
	function genCheckId(resolve, reject) {
		const uniqueId = gen();
		attempts.count++;
		data.has(uniqueId)
			.then((exists) => {
				log.debug('ID check', exists ? 'Taken' : 'Available');
				return attempts.count - 1 >= attempts.max ? reject(new Error('No ID\'s remaining')) : exists ? genCheckId(resolve, reject) : resolve(uniqueId);
			})
			.catch(reject);
	}

	new Promise((resolve, reject) => genCheckId(resolve, reject))
		.then((uniqueId) => {
			resourceId = uniqueId;
			log.debug('Saving data', data.name);
		})
		.then(() => data.put(resourceId.split('.')[0], req.file))
		.then(() => {
			// Log the upload
			const logInfo = `${req.file.originalname} (${req.file.mimetype}, ${formatBytes(req.file.size)})`;
			log.success('File uploaded', logInfo, `uploaded by ${users[req.token] ? users[req.token].username : '<token-only>'}`);

			// Build the URLs
			const resourceUrl = `${getTrueHttp()}${trueDomain}/${resourceId}`;
			const thumbnailUrl = `${getTrueHttp()}${trueDomain}/${resourceId}/thumbnail`;
			const deleteUrl = `${getTrueHttp()}${trueDomain}/${resourceId}/delete/${req.file.deleteId}`;

			// Send the response
			res.type('json').send({ resource: resourceUrl, thumbnail: thumbnailUrl, delete: deleteUrl })
				.on('finish', () => {
					log.debug('Upload response sent');

					// After we have sent the user the response, also send a Webhook to Discord (if headers are present)
					if (req.headers['x-ass-webhook-url']) {

						// Build the webhook
						const hook = new Webhook(req.headers['x-ass-webhook-url']);
						hook.setUsername(req.headers['x-ass-webhook-username'] || 'ass');
						hook.setAvatar(req.headers['x-ass-webhook-avatar'] || ASS_LOGO);

						// Build the embed
						const embed = new MessageBuilder()
							.setTitle(logInfo)
							.setURL(resourceUrl)
							.setDescription(`**Size:** \`${formatBytes(req.file.size)}\`\n**[Delete](${deleteUrl})**`)
							.setThumbnail(thumbnailUrl)
							.setColor(req.file.vibrant)
							.setTimestamp();

						// Send the embed to the webhook, then delete the client after to free resources
						log.debug('Sending embed to webhook');
						hook.send(embed)
							.then(() => log.debug('Webhook sent'))
							.catch((err) => log.error('Webhook error').err(err));
					}

					// Also update the users upload count
					if (!users[req.token]) {
						const generateUsername = () => generateId('random', 20, null); // skipcq: JS-0074
						let username = generateUsername();
						while (Object.values(users).findIndex((user) => user.username === username) !== -1)  // skipcq: JS-0073
							username = generateUsername();
						users[req.token] = { username, count: 0 };
					}
					users[req.token].count += 1;
					fs.writeJsonSync(path('auth.json'), { users }, { spaces: 4 });

					log.debug('Upload request flow completed', '');
				});
		}).catch(next);
});

module.exports = router;
