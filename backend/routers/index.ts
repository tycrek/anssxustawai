import fs from 'fs-extra';
import bb from 'express-busboy';
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { log } from '../log';
import { UserConfig } from '../UserConfig';
import { random } from '../generators';
import { BusBoyFile, AssFile } from 'ass';
import { uploadFileS3 } from '../s3';

const router = Router({ caseSensitive: true });

//@ts-ignore // Required since bb.extends expects express.Application, not a Router (but it still works)
bb.extend(router, {
	upload: true,
	restrictMultiple: true,
	allowedPath: (url: string) => url === '/',
	limits: {
		fileSize: () => (UserConfig.ready ? UserConfig.config.maximumFileSize : 50) * 1000000 // MB
	}
});

// Render or redirect
router.get('/', (req, res) => UserConfig.ready ? res.render('index') : res.redirect('/setup'));

// Upload flow
router.post('/', async (req, res) => {

	// Check user config
	if (!UserConfig.ready) return res.status(500).type('text').send('Configuration missing!');

	// Does the file actually exist
	if (!req.files || !req.files['file']) return res.status(400).type('text').send('No file was provided!');
	else log.debug('Upload request received', `Using ${UserConfig.config.s3 != null ? 'S3' : 'local'} storage`);

	// Type-check the file data
	const bbFile: BusBoyFile = req.files['file'];

	// Prepare file move
	const uploads = UserConfig.config.uploadsDir;
	const timestamp = Date.now().toString();
	const fileKey = `${timestamp}_${bbFile.filename}`;
	const destination = `${uploads}${uploads.endsWith('/') ? '' : '/'}${fileKey}`;

	// S3 configuration
	const s3 = UserConfig.config.s3 != null ? UserConfig.config.s3 : false;

	try {

		// Move the file
		if (!s3) await fs.move(bbFile.file, destination);
		else await uploadFileS3(await fs.readFile(bbFile.file), bbFile.mimetype, fileKey);

		// Build ass metadata
		const assFile: AssFile = {
			fakeid: random({ length: UserConfig.config.idSize }), // todo: more generators
			id: nanoid(32),
			fileKey,
			mimetype: bbFile.mimetype,
			filename: bbFile.filename,
			timestamp,
			uploader: '0', // todo: users
			save: {},
			sha256: '0' // todo: hashing
		};

		// Set the save location
		if (!s3) assFile.save.local = destination;
		else {

			// Using S3 doesn't move temp file, delete it now
			await fs.rm(bbFile.file);

			// todo: get S3 save data
		}

		log.debug('File saved to', !s3 ? assFile.save.local! : 'S3');

		// todo: save metadata

		return res.type('json').send({ resource: `${req.ass.host}/${assFile.fakeid}` });
	} catch (err) {
		log.error('Failed to upload file', bbFile.filename);
		console.error(err);
		return res.status(500).send(err);
	}
});

export { router };
