// https://docs.digitalocean.com/products/spaces/resources/s3-sdk-examples/
// https://www.digitalocean.com/community/tutorials/how-to-upload-a-file-to-object-storage-with-node-js

const fs = require('fs-extra');
const aws = require('aws-sdk');
const Thumbnail = require('./thumbnails');
const Vibrant = require('./vibrant');
const Hash = require('./hash');
const { getDatedDirname, generateId, log } = require('./utils');
const { s3enabled, s3endpoint, s3bucket, s3usePathStyle, s3accessKey, s3secretKey, saveAsOriginal, mediaStrict, maxUploadSize } = require('./config.json');
const { CODE_UNSUPPORTED_MEDIA_TYPE } = require('./MagicNumbers.json');

const ID_GEN_LENGTH = 32;
const ALLOWED_MIMETYPES = /(image)|(video)|(audio)\//;

const s3 = new aws.S3({
	s3ForcePathStyle: s3usePathStyle,
	endpoint: new aws.Endpoint(s3endpoint),
	credentials: new aws.Credentials({ accessKeyId: s3accessKey, secretAccessKey: s3secretKey })
});

function getLocalFilename(req) {
	return `${getDatedDirname()}/${saveAsOriginal ? req.file.originalname : req.file.sha1}`;
}

function processUploaded(req, res, next) {
	// Fix file object
	req.file = req.files.file;

	// Other fixes
	req.file.ext = '.'.concat(req.file.filename.split('.').pop());
	req.file.originalname = req.file.filename;
	req.file.path = req.file.file;
	req.file.randomId = generateId('random', ID_GEN_LENGTH, null, null);
	req.file.deleteId = generateId('random', ID_GEN_LENGTH, null, null);

	// Set up types
	req.file.is = {
		image: false,
		video: false,
		audio: false,
		other: false
	};

	// Specify correct type
	const isType = req.file.mimetype.includes('image') ? 'image' : req.file.mimetype.includes('video') ? 'video' : req.file.mimetype.includes('audio') ? 'audio' : 'other';
	req.file.is[isType] = true;

	// Block the resource if the mimetype is not an image or video
	if (mediaStrict && !ALLOWED_MIMETYPES.test(req.file.mimetype))
		return log
			.warn('Upload blocked', req.file.originalname, req.file.mimetype)
			.warn('Strict media mode', 'only images, videos, & audio are file permitted')
			.callback(() =>
				fs.remove(req.file.path)
					.then(() => log
						.debug('Temp file', 'deleted')
						.callback(() => res.sendStatus(CODE_UNSUPPORTED_MEDIA_TYPE)))
					.catch((err) => log
						.error('Temp file could not be deleted', err)
						.callback(next, err)));

	// Remove unwanted fields
	delete req.file.uuid;
	delete req.file.field;
	delete req.file.file;
	delete req.file.filename;
	delete req.file.truncated;
	delete req.file.done;

	// Operations
	Promise.all([Thumbnail(req.file), Vibrant(req.file), Hash(req.file), fs.stat(req.file.path)])
		// skipcq: JS-0086
		.then(([thumbnail, vibrant, sha1, stat]) => (
			req.file.thumbnail = thumbnail, // skipcq: JS-0090
			req.file.vibrant = vibrant, // skipcq: JS-0090
			req.file.sha1 = sha1, // skipcq: JS-0090
			req.file.size = stat.size // skipcq: JS-0090
		))

		// Check if file size is too big
		.then(() => { if (req.file.size / Math.pow(1024, 2) > maxUploadSize) throw new Error('LIMIT_FILE_SIZE'); })

		// Save file
		.then(() => log.debug('Saving file', req.file.originalname, s3enabled ? 'in S3' : 'on disk'))
		.then(() =>
			// skipcq: JS-0229
			new Promise((resolve, reject) => s3enabled

				// Upload to Amazon S3
				? s3.putObject({
					Bucket: s3bucket,
					Key: req.file.randomId.concat(req.file.ext),
					ACL: 'public-read',
					ContentType: req.file.mimetype,
					Body: fs.createReadStream(req.file.path)
				}).promise().then(resolve).catch(reject)

				// Save to local storage
				: fs.ensureDir(getDatedDirname())
					.then(() => fs.copy(req.file.path, getLocalFilename(req), { preserveTimestamps: true }))
					.then(resolve)
					.catch(reject)
			))
		.then(() => log.debug('File saved', req.file.originalname, s3enabled ? 'in S3' : 'on disk'))
		.then(() => !s3enabled && (req.file.path = getLocalFilename(req))) // skipcq: JS-0090
		.then(() => next())
		.catch(next)
		.finally(() => fs.remove(req.file.path))
		.then(() => log.debug('Temp file', 'deleted'))
		.catch((err) => log.err(err));
}

function deleteS3(file) {
	return new Promise((resolve, reject) => s3
		.deleteObject({ Bucket: s3bucket, Key: file.randomId.concat(file.ext) })
		.promise()
		.then(resolve)
		.catch(reject));
}

function listAllKeys(resolve, reject, token) {
	let allKeys = [];
	s3.listObjectsV2({ Bucket: s3bucket, ContinuationToken: token }).promise()
		.then((data) => (allKeys = allKeys.concat(data.Contents), data.IsTruncated ? listAllKeys(resolve, reject, data.NextContinuationToken) : resolve(allKeys.length))) // skipcq: JS-0086, JS-0090
		.catch(reject);
}

function bucketSize() {
	return new Promise((resolve, reject) => (s3enabled ? listAllKeys(resolve, reject) : resolve(0)));
}

module.exports = {
	processUploaded,
	deleteS3,
	bucketSize
};
