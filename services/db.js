const co = require("co");
const Promise = require("bluebird");
const cradle	= Promise.promisifyAll(require("cradle"));

// A custom Error just for database problems.
function CouchDBError(message) {
	this.name = "CouchDBError";
	this.message = (message || "");
}
CouchDBError.prototype = Error.prototype;

// Connects to a database and returns the DB object.
const connectToDatabase = (dbName) => {
	try {
		return new(cradle.Connection)().database(dbName);
	} catch (err) {
		throw new CouchDBError(`DB: Get: Connection to database [${dbName}] failed`);
	}
};

exports.createDatabase = function* createDatabase(database) {
	try {
		const db = connectToDatabase(database);
		const confirmation = yield db.createAsync();
		confirmation.error = false;
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
		const db = connectToDatabase(database);
		const confirmation = yield db.destroyAsync();
		confirmation.error = false;
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
		const db = connectToDatabase(database);
		const doc = yield db.getAsync(id);
		doc.error = false;
		return doc;
	} catch (err) {
		return {
			error: true,
			message: `DB: Get of [${id}] failed`
		};
	}
};

// Saves a document in a database in CouchDB.
exports.saveDocument = function* saveDocument(document, database) {
	try {
		const db = connectToDatabase(database);
		const returnVal = yield db.saveAsync(document._id, document);
		document.error = false;
		return document;
	} catch (err) {
		throw new Error(err.stack);
		return {
			error: true,
			message: `DB: Save of [${document._id}] failed`
		};
	}
};

// Removes a document in a database in CouchDB.
exports.removeDocument = function* removeDocument(id, database) {
	try {
		const db = connectToDatabase(database);
		const returnVal = yield db.removeAsync(id);
		returnVal.error = false;
		return returnVal;
	} catch (err) {
		return {
			error: true,
			message: `DB: Delete of [${id}] failed`
		};
	}
};

// Gets a view from a database in CouchDB.
exports.runView = function* runView(path, key, database, opts = {}) {
	try {
		const db = connectToDatabase(database);
		const returnVal = {};
		if (key !== null) {
			opts.key = key;
		}
		returnVal.results = yield db.viewAsync(path, opts);
		returnVal.error = false;
		return returnVal;
	} catch (err) {
		return {
			error: true,
			message: `DB: View of [${path}] failed`
		};
	}
};

// Saves a view to a database in CouchDB
// Saves a document in a database in CouchDB.
exports.saveView = function* saveView(id, view, database) {
	try {
		const db = connectToDatabase(database);
		const document = yield db.saveAsync(`_design/${id}`, view);
		document.error = false;
		return document;
	} catch (err) {
		return {
			error: true,
			message: `DB: Save of [${id}] view failed`
		};
	}
};
