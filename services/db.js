const co = require("co");
const Promise = require("bluebird");
const fs = Promise.promisifyAll(require("fs"));

exports.createDatabase = function* createDatabase(database) {
	try {
		yield fs.mkdirAsync(`${__dirname}/../data/${database}`);
		const confirmation = {
			error: false
		};
		return confirmation;
	} catch (err) {
		return {
			error: true,
			message: `DB: Create of [${database}] failed`
		};
	}
};

exports.deleteDatabase = function* deleteDatabase(database) {
	try {
		yield fs.rmdirAsync(`${__dirname}/../data/${database}`);
		const confirmation = {
			error: false
		};
		return confirmation;
	} catch (err) {
		return {
			error: true,
			message: `DB: Delete of [${database}] failed`
		};
	}
};

// Grabs a document from a database in CouchDB.
exports.getDocument = function* getDocument(id, database) {
	try {
		const file = yield fs.readFileAsync(`${__dirname}/../data/${database}/${id}.json`);
		const result = JSON.parse(file);
		result.error = false;
		return result;
	} catch (err) {
		return {
			error: true,
			message: `DB: Get of [${database}/${id}] failed`
		};
	}
};

// Saves a document in a database in CouchDB.
exports.saveDocument = function* saveDocument(document, database) {
	try {
		yield fs.writeFileAsync(`${__dirname}/../data/${database}/${document._id}.json`, JSON.stringify(document, null, 2));
		const confirmation = {
			error: false
		};
		return confirmation;
	} catch (err) {
		return {
			error: true,
			message: `DB: Save of [${database}/${id}] failed`
		};
	}
};

// Removes a document in a database in CouchDB.
exports.removeDocument = function* removeDocument(id, database) {
	try {
		yield fs.unlinkAsync(`${__dirname}/../data/${database}/${id}.json`);
		const confirmation = {
			error: false
		};
		return confirmation;
	} catch (err) {
		return {
			error: true,
			message: `DB: Delete of [${database}/${id}] failed`
		};
	}
};
