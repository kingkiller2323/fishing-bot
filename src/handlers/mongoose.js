const { connect } = require('mongoose');
const config = require('../config');
const { Utils } = require('../class/Utils');

module.exports = async () => {
	Utils.log('Started connecting to MongoDB...', 'warn');

	const uri = process.env.MONGODB_URI || config.handler.mongodb.uri;
	if (!uri) throw new Error('MONGODB_URI is not set.');

	await connect(uri).then(() => {
		Utils.log('MongoDB is connected to the atlas!', 'done');
	});
};