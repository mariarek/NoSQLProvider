"use strict";
/**
 * SqlProviderBase.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * Abstract helpers for all NoSqlProvider DbProviders that are based on SQL backings.
 */
var __extends = (this && this.__extends) || (function () {
    var extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
var _ = require("lodash");
var SyncTasks = require("synctasks");
var FullTextSearchHelpers = require("./FullTextSearchHelpers");
var NoSqlProvider = require("./NoSqlProvider");
var NoSqlProviderUtils = require("./NoSqlProviderUtils");
var schemaVersionKey = 'schemaVersion';
// This was taked from the sqlite documentation
var SQLITE_MAX_SQL_LENGTH_IN_BYTES = 1000000;
function getIndexIdentifier(storeSchema, index) {
    return storeSchema.name + '_' + index.name;
}
// Certain indexes use a separate table for pivot:
// * Multientry indexes
// * Full-text indexes that support FTS3
function indexUsesSeparateTable(indexSchema, supportsFTS3) {
    return indexSchema.multiEntry || (!!indexSchema.fullText && supportsFTS3);
}
var FakeFTSJoinToken = '^$^';
// Limit LIMIT numbers to a reasonable size to not break queries.
var LimitMax = Math.pow(2, 32);
var SqlProviderBase = /** @class */ (function (_super) {
    __extends(SqlProviderBase, _super);
    function SqlProviderBase(_supportsFTS3) {
        var _this = _super.call(this) || this;
        _this._supportsFTS3 = _supportsFTS3;
        return _this;
        // NOP
    }
    SqlProviderBase.prototype._getMetadata = function (trans) {
        // Create table if needed
        return trans.runQuery('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)').then(function () {
            return trans.runQuery('SELECT name, value from metadata', []);
        });
    };
    SqlProviderBase.prototype._storeIndexMetadata = function (trans, meta) {
        return trans.runQuery('INSERT OR REPLACE into metadata (\'name\', \'value\') VALUES' +
            '(\'' + meta.key + '\', ?)', [JSON.stringify(meta)]);
    };
    SqlProviderBase.prototype._getDbVersion = function () {
        return this.openTransaction(undefined, true).then(function (trans) {
            // Create table if needed
            return trans.runQuery('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)').then(function () {
                return trans.runQuery('SELECT value from metadata where name=?', [schemaVersionKey]).then(function (data) {
                    if (data && data[0] && data[0].value) {
                        return Number(data[0].value) || 0;
                    }
                    return 0;
                });
            });
        });
    };
    SqlProviderBase.prototype._changeDbVersion = function (oldVersion, newVersion) {
        return this.openTransaction(undefined, true).then(function (trans) {
            return trans.runQuery('INSERT OR REPLACE into metadata (\'name\', \'value\') VALUES (\'' + schemaVersionKey + '\', ?)', [newVersion])
                .then(function () { return trans; });
        });
    };
    SqlProviderBase.prototype._ourVersionChecker = function (wipeIfExists) {
        var _this = this;
        return this._getDbVersion()
            .then(function (oldVersion) {
            if (oldVersion !== _this._schema.version) {
                // Needs a schema upgrade/change
                if (!wipeIfExists && _this._schema.version < oldVersion) {
                    console.log('Database version too new (' + oldVersion + ') for schema version (' + _this._schema.version +
                        '). Wiping!');
                    wipeIfExists = true;
                }
                return _this._changeDbVersion(oldVersion, _this._schema.version).then(function (trans) {
                    return _this._upgradeDb(trans, oldVersion, wipeIfExists);
                });
            }
            else if (wipeIfExists) {
                // No version change, but wipe anyway
                return _this.openTransaction(undefined, true).then(function (trans) {
                    return _this._upgradeDb(trans, oldVersion, true);
                });
            }
            return undefined;
        });
    };
    SqlProviderBase.prototype._upgradeDb = function (trans, oldVersion, wipeAnyway) {
        var _this = this;
        // Get a list of all tables and indexes on the tables
        return this._getMetadata(trans).then(function (fullMeta) {
            // Get Index metadatas
            var indexMetadata = _.map(fullMeta, function (meta) {
                var metaObj;
                _.attempt(function () {
                    metaObj = JSON.parse(meta.value);
                });
                return metaObj;
            })
                .filter(function (meta) { return !!meta && !!meta.storeName; });
            return trans.runQuery('SELECT type, name, tbl_name, sql from sqlite_master', [])
                .then(function (rows) {
                var tableNames = [];
                var indexNames = {};
                var indexTables = {};
                var tableSqlStatements = {};
                _.each(rows, function (row) {
                    var tableName = row['tbl_name'];
                    // Ignore browser metadata tables for websql support
                    if (tableName === '__WebKitDatabaseInfoTable__' || tableName === 'metadata') {
                        return;
                    }
                    // Ignore FTS-generated side tables
                    var endsIn = function (str, checkstr) {
                        var i = str.indexOf(checkstr);
                        return i !== -1 && i === str.length - checkstr.length;
                    };
                    if (endsIn(tableName, '_content') || endsIn(tableName, '_segments') || endsIn(tableName, '_segdir')) {
                        return;
                    }
                    if (row['type'] === 'table') {
                        tableNames.push(row['name']);
                        tableSqlStatements[row['name']] = row['sql'];
                        var nameSplit = row['name'].split('_');
                        if (nameSplit.length === 1) {
                            if (!indexNames[row['name']]) {
                                indexNames[row['name']] = [];
                            }
                            if (!indexTables[row['name']]) {
                                indexTables[row['name']] = [];
                            }
                        }
                        else {
                            var tableName_1 = nameSplit[0];
                            if (indexTables[tableName_1]) {
                                indexTables[tableName_1].push(nameSplit[1]);
                            }
                            else {
                                indexTables[tableName_1] = [nameSplit[1]];
                            }
                        }
                    }
                    if (row['type'] === 'index') {
                        if (row['name'].substring(0, 17) === 'sqlite_autoindex_') {
                            // auto-index, ignore
                            return;
                        }
                        if (!indexNames[tableName]) {
                            indexNames[tableName] = [];
                        }
                        indexNames[tableName].push(row['name']);
                    }
                });
                // Check each table!
                var dropQueries = [];
                if (wipeAnyway || (_this._schema.lastUsableVersion && oldVersion < _this._schema.lastUsableVersion)) {
                    // Clear all stores if it's past the usable version
                    if (!wipeAnyway) {
                        console.log('Old version detected (' + oldVersion + '), clearing all tables');
                    }
                    dropQueries = _.map(tableNames, function (name) { return trans.runQuery('DROP TABLE ' + name); });
                    if (indexMetadata.length > 0) {
                        // Drop all existing metadata
                        var placeholder = Array.apply(null, new Array(indexMetadata.length)).map(function () { return '?'; }).join(',');
                        dropQueries.push(trans.runQuery('DELETE FROM metadata WHERE name IN (' + placeholder + ')', _.map(indexMetadata, function (meta) { return meta.key; })));
                        indexMetadata = [];
                    }
                    tableNames = [];
                }
                else {
                    // Just delete tables we don't care about anymore. Preserve multi-entry tables, they may not be changed
                    var tableNamesNeeded_1 = [];
                    _.each(_this._schema.stores, function (store) {
                        tableNamesNeeded_1.push(store.name);
                        _.each(store.indexes, function (index) {
                            if (indexUsesSeparateTable(index, _this._supportsFTS3)) {
                                tableNamesNeeded_1.push(getIndexIdentifier(store, index));
                            }
                        });
                    });
                    var tableNamesNotNeeded = _.filter(tableNames, function (name) { return !_.includes(tableNamesNeeded_1, name); });
                    dropQueries = _.flatten(_.map(tableNamesNotNeeded, function (name) {
                        var transList = [trans.runQuery('DROP TABLE ' + name)];
                        var metasToDelete = _.filter(indexMetadata, function (meta) { return meta.storeName === name; });
                        var metaKeysToDelete = _.map(metasToDelete, function (meta) { return meta.key; });
                        // Clean up metas
                        if (metasToDelete.length > 0) {
                            var placeholder = Array.apply(null, new Array(metasToDelete.length)).map(function () { return '?'; }).join(',');
                            transList.push(trans.runQuery('DELETE FROM metadata where name in (' + placeholder + ')', _.map(metasToDelete, function (meta) { return meta.key; })));
                            indexMetadata = _.filter(indexMetadata, function (meta) { return !_.includes(metaKeysToDelete, meta.key); });
                        }
                        return transList;
                    }));
                    tableNames = _.filter(tableNames, function (name) { return _.includes(tableNamesNeeded_1, name); });
                }
                return SyncTasks.all(dropQueries).then(function () {
                    var tableQueries = [];
                    // Go over each store and see what needs changing
                    _.each(_this._schema.stores, function (storeSchema) {
                        // creates indexes for provided schemas 
                        var indexMaker = function (indexes) {
                            if (indexes === void 0) { indexes = []; }
                            var metaQueries = [];
                            var indexQueries = _.map(indexes, function (index) {
                                var indexIdentifier = getIndexIdentifier(storeSchema, index);
                                // Store meta for the index
                                var newMeta = {
                                    key: indexIdentifier,
                                    storeName: storeSchema.name,
                                    index: index
                                };
                                metaQueries.push(_this._storeIndexMetadata(trans, newMeta));
                                // Go over each index and see if we need to create an index or a table for a multiEntry index
                                if (index.multiEntry) {
                                    if (NoSqlProviderUtils.isCompoundKeyPath(index.keyPath)) {
                                        return SyncTasks.Rejected('Can\'t use multiEntry and compound keys');
                                    }
                                    else {
                                        return trans.runQuery('CREATE TABLE ' + indexIdentifier + ' (nsp_key TEXT, nsp_refpk TEXT' +
                                            (index.includeDataInIndex ? ', nsp_data TEXT' : '') + ')').then(function () {
                                            return trans.runQuery('CREATE ' + (index.unique ? 'UNIQUE ' : '') + 'INDEX ' +
                                                indexIdentifier + '_pi ON ' + indexIdentifier + ' (nsp_key, nsp_refpk' +
                                                (index.includeDataInIndex ? ', nsp_data' : '') + ')');
                                        });
                                    }
                                }
                                else if (index.fullText && _this._supportsFTS3) {
                                    // If FTS3 isn't supported, we'll make a normal column and use LIKE to seek over it, so the
                                    // fallback below works fine.
                                    return trans.runQuery('CREATE VIRTUAL TABLE ' + indexIdentifier +
                                        ' USING FTS3(nsp_key TEXT, nsp_refpk TEXT)');
                                }
                                else {
                                    return trans.runQuery('CREATE ' + (index.unique ? 'UNIQUE ' : '') + 'INDEX ' + indexIdentifier +
                                        ' ON ' + storeSchema.name + ' (nsp_i_' + index.name +
                                        (index.includeDataInIndex ? ', nsp_data' : '') + ')');
                                }
                            });
                            return SyncTasks.all(indexQueries.concat(metaQueries));
                        };
                        // Form SQL statement for table creation
                        var fieldList = [];
                        fieldList.push('nsp_pk TEXT PRIMARY KEY');
                        fieldList.push('nsp_data TEXT');
                        var columnBasedIndexes = _.filter(storeSchema.indexes, function (index) {
                            return !indexUsesSeparateTable(index, _this._supportsFTS3);
                        });
                        var indexColumns = _.map(columnBasedIndexes, function (index) { return 'nsp_i_' + index.name + ' TEXT'; });
                        fieldList = fieldList.concat(indexColumns);
                        var tableMakerSql = 'CREATE TABLE ' + storeSchema.name + ' (' + fieldList.join(', ') + ')';
                        var currentIndexMetas = _.filter(indexMetadata, function (meta) { return meta.storeName === storeSchema.name; });
                        // find new indices which don't require backfill
                        var newNoBackfillIndices = _.filter(storeSchema.indexes, function (index) {
                            var indexIdentifier = getIndexIdentifier(storeSchema, index);
                            return !!index.doNotBackfill && !_.some(currentIndexMetas, function (meta) { return meta.key === indexIdentifier; });
                        });
                        // columns requiring no backfill could be simply added to the table
                        var newIndexColumnsNoBackfill = _.intersection(newNoBackfillIndices, columnBasedIndexes);
                        var columnAdder = function () {
                            var addQueries = _.map(newIndexColumnsNoBackfill, function (index) {
                                return trans.runQuery('ALTER TABLE ' + storeSchema.name + ' ADD COLUMN ' + 'nsp_i_' + index.name + ' TEXT');
                            });
                            return SyncTasks.all(addQueries);
                        };
                        var tableMaker = function () {
                            // Create the table
                            return trans.runQuery(tableMakerSql)
                                .then(function () { return indexMaker(storeSchema.indexes); });
                        };
                        var needsDataMigration = function () {
                            //  If some indices have been removed - migration is needed
                            var areIndicesRemoved = _.some(currentIndexMetas, function (meta) {
                                return !_.some(storeSchema.indexes, function (newIndex) { return getIndexIdentifier(storeSchema, newIndex) === meta.key; });
                            });
                            if (areIndicesRemoved) {
                                return true;
                            }
                            // Check all the indices in the schema
                            return _.some(storeSchema.indexes, function (index) {
                                var indexIdentifier = getIndexIdentifier(storeSchema, index);
                                var indexMeta = _.find(indexMetadata, function (meta) { return meta.key === indexIdentifier; });
                                // if there's a new index that doesn't require backfill, continue
                                if (!indexMeta && index.doNotBackfill) {
                                    return false;
                                }
                                // If we have a new index that requires backfill - we need to migrate 
                                if (!indexMeta) {
                                    return true;
                                }
                                // If the index schemas don't match - we need to migrate
                                if (!_.isEqual(indexMeta.index, index)) {
                                    return true;
                                }
                                // Check that indicies actually exist in the right place
                                if (indexUsesSeparateTable(index, _this._supportsFTS3)) {
                                    if (!_.includes(tableNames, indexIdentifier)) {
                                        return true;
                                    }
                                }
                                else {
                                    if (!_.includes(indexNames[storeSchema.name], indexIdentifier)) {
                                        return true;
                                    }
                                }
                                return false;
                            });
                        };
                        // If the table exists, check if we can view the sql statement used to create this table. Use it to determine
                        // if a migration is needed, otherwise just make a copy and fully migrate the data over.
                        var tableExists = _.includes(tableNames, storeSchema.name);
                        var tableRequiresMigration = tableExists && needsDataMigration();
                        if (tableExists && tableRequiresMigration) {
                            // Nuke old indexes on the original table (since they don't change names and we don't need them anymore).
                            // Also new old multientry/FTS tables (if they still exist after the purge above.)
                            var indexDroppers = _.map(indexNames[storeSchema.name], function (indexName) {
                                return trans.runQuery('DROP INDEX ' + indexName);
                            }).concat(_.map(indexTables[storeSchema.name], function (tableName) {
                                return trans.runQuery('DROP TABLE IF EXISTS ' + storeSchema.name + '_' + tableName);
                            }));
                            var nukeIndexesAndRename = SyncTasks.all(indexDroppers).then(function () {
                                // Then rename the table to a temp_[name] table so we can migrate the data out of it
                                return trans.runQuery('ALTER TABLE ' + storeSchema.name + ' RENAME TO temp_' + storeSchema.name);
                            });
                            // Migrate the data over using our existing put functions
                            // (since it will do the right things with the indexes)
                            // and delete the temp table.
                            var migrator = function () {
                                var store = trans.getStore(storeSchema.name);
                                return trans.internal_getResultsFromQuery('SELECT nsp_data FROM temp_' + storeSchema.name)
                                    .then(function (objs) {
                                    return store.put(objs).then(function () {
                                        return trans.runQuery('DROP TABLE temp_' + storeSchema.name);
                                    });
                                });
                            };
                            tableQueries.push(nukeIndexesAndRename.then(tableMaker).then(migrator));
                        }
                        else if (tableExists && newNoBackfillIndices.length > 0) {
                            // we can add new indices without migrating
                            tableQueries.push(columnAdder().then(function () { return indexMaker(newNoBackfillIndices); }));
                        }
                        else if (!tableExists) {
                            // Table doesn't exist -- just go ahead and create it without the migration path
                            tableQueries.push(tableMaker());
                        }
                    });
                    return SyncTasks.all(tableQueries);
                });
            });
        }).then(_.noop);
    };
    return SqlProviderBase;
}(NoSqlProvider.DbProvider));
exports.SqlProviderBase = SqlProviderBase;
// The DbTransaction implementation for the WebSQL DbProvider.  All WebSQL accesses go through the transaction
// object, so this class actually has several helpers for executing SQL queries, getting results from them, etc.
var SqlTransaction = /** @class */ (function () {
    function SqlTransaction(_schema, _verbose, _maxVariables, _supportsFTS3) {
        this._schema = _schema;
        this._verbose = _verbose;
        this._maxVariables = _maxVariables;
        this._supportsFTS3 = _supportsFTS3;
        this._isOpen = true;
        if (this._verbose) {
            console.log('Opening Transaction');
        }
    }
    SqlTransaction.prototype._isTransactionOpen = function () {
        return this._isOpen;
    };
    SqlTransaction.prototype.internal_markTransactionClosed = function () {
        if (this._verbose) {
            console.log('Marking Transaction Closed');
        }
        this._isOpen = false;
    };
    SqlTransaction.prototype.internal_getMaxVariables = function () {
        return this._maxVariables;
    };
    SqlTransaction.prototype.internal_nonQuery = function (sql, parameters) {
        return this.runQuery(sql, parameters).then(_.noop);
    };
    SqlTransaction.prototype.internal_getResultsFromQuery = function (sql, parameters) {
        return this.runQuery(sql, parameters).then(function (rows) {
            var rets = [];
            for (var i = 0; i < rows.length; i++) {
                try {
                    rets.push(JSON.parse(rows[i].nsp_data));
                }
                catch (e) {
                    return SyncTasks.Rejected('Error parsing database entry in getResultsFromQuery: ' + JSON.stringify(rows[i].nsp_data));
                }
            }
            return rets;
        });
    };
    SqlTransaction.prototype.internal_getResultFromQuery = function (sql, parameters) {
        return this.internal_getResultsFromQuery(sql, parameters)
            .then(function (rets) { return rets.length < 1 ? undefined : rets[0]; });
    };
    SqlTransaction.prototype.getStore = function (storeName) {
        var storeSchema = _.find(this._schema.stores, function (store) { return store.name === storeName; });
        if (!storeSchema) {
            throw new Error('Store not found: ' + storeName);
        }
        return new SqlStore(this, storeSchema, this._requiresUnicodeReplacement(), this._supportsFTS3, this._verbose);
    };
    SqlTransaction.prototype.markCompleted = function () {
        // noop
    };
    SqlTransaction.prototype._requiresUnicodeReplacement = function () {
        return false;
    };
    return SqlTransaction;
}());
exports.SqlTransaction = SqlTransaction;
// Generic base transaction for anything that matches the syntax of a SQLTransaction interface for executing sql commands.
// Conveniently, this works for both WebSql and cordova's Sqlite plugin.
var SqliteSqlTransaction = /** @class */ (function (_super) {
    __extends(SqliteSqlTransaction, _super);
    function SqliteSqlTransaction(_trans, schema, verbose, maxVariables, supportsFTS3) {
        var _this = _super.call(this, schema, verbose, maxVariables, supportsFTS3) || this;
        _this._trans = _trans;
        _this._pendingQueries = [];
        return _this;
    }
    // If an external provider of the transaction determines that the transaction has failed but won't report its failures
    // (i.e. in the case of WebSQL), we need a way to kick the hanging queries that they're going to fail since otherwise
    // they'll never respond.
    SqliteSqlTransaction.prototype.failAllPendingQueries = function (error) {
        var list = this._pendingQueries;
        this._pendingQueries = [];
        _.each(list, function (query) {
            query.reject(error);
        });
    };
    SqliteSqlTransaction.prototype.runQuery = function (sql, parameters) {
        var _this = this;
        if (!this._isTransactionOpen()) {
            return SyncTasks.Rejected('SqliteSqlTransaction already closed');
        }
        var deferred = SyncTasks.Defer();
        this._pendingQueries.push(deferred);
        var startTime;
        if (this._verbose) {
            startTime = Date.now();
        }
        var errRet = _.attempt(function () {
            _this._trans.executeSql(sql, parameters, function (t, rs) {
                var index = _.indexOf(_this._pendingQueries, deferred);
                if (index !== -1) {
                    var rows = [];
                    for (var i = 0; i < rs.rows.length; i++) {
                        rows.push(rs.rows.item(i));
                    }
                    _this._pendingQueries.splice(index, 1);
                    deferred.resolve(rows);
                }
                else {
                    console.error('SQL statement resolved twice (success this time): ' + sql);
                }
            }, function (t, err) {
                if (!err) {
                    // The cordova-native-sqlite-storage plugin only passes a single parameter here, the error,
                    // slightly breaking the interface.
                    err = t;
                }
                var index = _.indexOf(_this._pendingQueries, deferred);
                if (index !== -1) {
                    _this._pendingQueries.splice(index, 1);
                    deferred.reject(err);
                }
                else {
                    console.error('SQL statement resolved twice (this time with failure)');
                }
                return _this.getErrorHandlerReturnValue();
            });
        });
        if (errRet) {
            deferred.reject(errRet);
        }
        var promise = deferred.promise();
        if (this._verbose) {
            promise = promise.finally(function () {
                console.log('SqlTransaction RunQuery: (' + (Date.now() - startTime) + 'ms): SQL: ' + sql);
            });
        }
        return promise;
    };
    return SqliteSqlTransaction;
}(SqlTransaction));
exports.SqliteSqlTransaction = SqliteSqlTransaction;
// DbStore implementation for the SQL-based DbProviders.  Implements the getters/setters against the transaction object and all of the
// glue for index/compound key support.
var SqlStore = /** @class */ (function () {
    function SqlStore(_trans, _schema, _replaceUnicode, _supportsFTS3, _verbose) {
        this._trans = _trans;
        this._schema = _schema;
        this._replaceUnicode = _replaceUnicode;
        this._supportsFTS3 = _supportsFTS3;
        this._verbose = _verbose;
        // Empty
    }
    SqlStore.prototype.get = function (key) {
        var _this = this;
        var joinedKey;
        var err = _.attempt(function () {
            joinedKey = NoSqlProviderUtils.serializeKeyToString(key, _this._schema.primaryKeyPath);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }
        var startTime;
        if (this._verbose) {
            startTime = Date.now();
        }
        var promise = this._trans.internal_getResultFromQuery('SELECT nsp_data FROM ' + this._schema.name +
            ' WHERE nsp_pk = ?', [joinedKey]);
        if (this._verbose) {
            promise = promise.finally(function () {
                console.log('SqlStore (' + _this._schema.name + ') get: (' + (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    };
    SqlStore.prototype.getMultiple = function (keyOrKeys) {
        var _this = this;
        var joinedKeys;
        var err = _.attempt(function () {
            joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, _this._schema.primaryKeyPath);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }
        if (joinedKeys.length === 0) {
            return SyncTasks.Resolved([]);
        }
        var startTime;
        if (this._verbose) {
            startTime = Date.now();
        }
        var qmarks = _.map(joinedKeys, function (k) { return '?'; });
        var promise = this._trans.internal_getResultsFromQuery('SELECT nsp_data FROM ' + this._schema.name + ' WHERE nsp_pk IN (' +
            qmarks.join(',') + ')', joinedKeys);
        if (this._verbose) {
            promise = promise.finally(function () {
                console.log('SqlStore (' + _this._schema.name + ') getMultiple: (' + (Date.now() - startTime) + 'ms): Count: ' +
                    joinedKeys.length);
            });
        }
        return promise;
    };
    SqlStore.prototype.put = function (itemOrItems) {
        var _this = this;
        var items = NoSqlProviderUtils.arrayify(itemOrItems);
        if (items.length === 0) {
            return SyncTasks.Resolved();
        }
        var startTime;
        if (this._verbose) {
            startTime = Date.now();
        }
        var fields = ['nsp_pk', 'nsp_data'];
        var qmarks = ['?', '?'];
        var args = [];
        var datas;
        _.each(this._schema.indexes, function (index) {
            if (!indexUsesSeparateTable(index, _this._supportsFTS3)) {
                qmarks.push('?');
                fields.push('nsp_i_' + index.name);
            }
        });
        var qmarkString = qmarks.join(',');
        var err = _.attempt(function () {
            datas = _.map(items, function (item) {
                var serializedData = JSON.stringify(item);
                // For now, until an issue with cordova-ios is fixed (https://issues.apache.org/jira/browse/CB-9435), have to replace
                // \u2028 and 2029 with blanks because otherwise the command boundary with cordova-ios silently eats any strings with them.
                if (_this._replaceUnicode) {
                    serializedData = serializedData.replace(SqlStore._unicodeFixer, '');
                }
                args.push(NoSqlProviderUtils.getSerializedKeyForKeypath(item, _this._schema.primaryKeyPath), serializedData);
                _.each(_this._schema.indexes, function (index) {
                    if (indexUsesSeparateTable(index, _this._supportsFTS3)) {
                        return;
                    }
                    if (index.fullText && !_this._supportsFTS3) {
                        args.push(FakeFTSJoinToken +
                            FullTextSearchHelpers.getFullTextIndexWordsForItem(index.keyPath, item).join(FakeFTSJoinToken));
                    }
                    else if (!index.multiEntry) {
                        args.push(NoSqlProviderUtils.getSerializedKeyForKeypath(item, index.keyPath));
                    }
                });
                return serializedData;
            });
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }
        // Need to not use too many variables per insert, so batch the insert if needed.
        var queries = [];
        var itemPageSize = Math.floor(this._trans.internal_getMaxVariables() / fields.length);
        for (var i = 0; i < items.length; i += itemPageSize) {
            var thisPageCount = Math.min(itemPageSize, items.length - i);
            var qmarksValues = _.fill(new Array(thisPageCount), qmarkString);
            queries.push(this._trans.internal_nonQuery('INSERT OR REPLACE INTO ' + this._schema.name + ' (' + fields.join(',') +
                ') VALUES (' + qmarksValues.join('),(') + ')', args.splice(0, thisPageCount * fields.length)));
        }
        // Also prepare mulltiEntry and FullText indexes
        if (_.some(this._schema.indexes, function (index) { return indexUsesSeparateTable(index, _this._supportsFTS3); })) {
            _.each(items, function (item, itemIndex) {
                var key;
                var err = _.attempt(function () {
                    key = NoSqlProviderUtils.getSerializedKeyForKeypath(item, _this._schema.primaryKeyPath);
                });
                if (err) {
                    queries.push(SyncTasks.Rejected(err));
                    return;
                }
                _.each(_this._schema.indexes, function (index) {
                    var serializedKeys;
                    if (index.fullText && _this._supportsFTS3) {
                        // FTS3 terms go in a separate virtual table...
                        serializedKeys = [FullTextSearchHelpers.getFullTextIndexWordsForItem(index.keyPath, item).join(' ')];
                    }
                    else if (index.multiEntry) {
                        // Have to extract the multiple entries into the alternate table...
                        var valsRaw_1 = NoSqlProviderUtils.getValueForSingleKeypath(item, index.keyPath);
                        if (valsRaw_1) {
                            var err_1 = _.attempt(function () {
                                serializedKeys = _.map(NoSqlProviderUtils.arrayify(valsRaw_1), function (val) {
                                    return NoSqlProviderUtils.serializeKeyToString(val, index.keyPath);
                                });
                            });
                            if (err_1) {
                                queries.push(SyncTasks.Rejected(err_1));
                                return;
                            }
                        }
                    }
                    else {
                        return;
                    }
                    var valArgs = [], insertArgs = [];
                    _.each(serializedKeys, function (val) {
                        valArgs.push(index.includeDataInIndex ? '(?, ?, ?)' : '(?, ?)');
                        insertArgs.push(val);
                        insertArgs.push(key);
                        if (index.includeDataInIndex) {
                            insertArgs.push(datas[itemIndex]);
                        }
                    });
                    queries.push(_this._trans.internal_nonQuery('DELETE FROM ' + _this._schema.name + '_' + index.name +
                        ' WHERE nsp_refpk = ?', [key])
                        .then(function () {
                        if (valArgs.length > 0) {
                            return _this._trans.internal_nonQuery('INSERT INTO ' + _this._schema.name + '_' + index.name +
                                ' (nsp_key, nsp_refpk' + (index.includeDataInIndex ? ', nsp_data' : '') + ') VALUES ' +
                                valArgs.join(','), insertArgs);
                        }
                        return undefined;
                    }));
                });
            });
        }
        var promise = SyncTasks.all(queries);
        if (this._verbose) {
            promise = promise.finally(function () {
                console.log('SqlStore (' + _this._schema.name + ') put: (' + (Date.now() - startTime) + 'ms): Count: ' + items.length);
            });
        }
        return promise.then(_.noop);
    };
    SqlStore.prototype.remove = function (keyOrKeys) {
        var _this = this;
        var joinedKeys = [];
        var err = _.attempt(function () {
            joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, _this._schema.primaryKeyPath);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }
        var startTime;
        if (this._verbose) {
            startTime = Date.now();
        }
        // Partition the parameters
        var arrayOfParams = [[]];
        var totalLength = 0;
        var totalItems = 0;
        var partitionIndex = 0;
        joinedKeys.forEach(function (joinedKey) {
            // Append the new item to the current partition
            arrayOfParams[partitionIndex].push(joinedKey);
            // Accumulate the length
            totalLength += joinedKey.length + 2;
            totalItems++;
            // Make sure we don't exceed the following sqlite limits, if so go to the next partition
            var didReachSqlStatementLimit = totalLength > (SQLITE_MAX_SQL_LENGTH_IN_BYTES - 200);
            var didExceedMaxVariableCount = totalItems >= _this._trans.internal_getMaxVariables();
            if (didReachSqlStatementLimit || didExceedMaxVariableCount) {
                totalLength = 0;
                totalItems = 0;
                partitionIndex++;
                arrayOfParams.push(new Array());
            }
        });
        var queries = _.map(arrayOfParams, function (params) {
            var queries = [];
            // Generate as many '?' as there are params
            var sqlPart = Array.apply(null, new Array(params.length)).map(function () { return '?'; }).join(',');
            _.each(_this._schema.indexes, function (index) {
                if (indexUsesSeparateTable(index, _this._supportsFTS3)) {
                    queries.push(_this._trans.internal_nonQuery('DELETE FROM ' + _this._schema.name + '_' + index.name +
                        ' WHERE nsp_refpk IN (' + sqlPart + ')', params));
                }
            });
            queries.push(_this._trans.internal_nonQuery('DELETE FROM ' + _this._schema.name +
                ' WHERE nsp_pk IN (' + sqlPart + ')', params));
            return SyncTasks.all(queries).then(_.noop);
        });
        var promise = SyncTasks.all(queries).then(_.noop);
        if (this._verbose) {
            promise = promise.finally(function () {
                console.log('SqlStore (' + _this._schema.name + ') remove: (' + (Date.now() - startTime) + 'ms): Count: ' +
                    joinedKeys.length);
            });
        }
        return promise;
    };
    SqlStore.prototype.openIndex = function (indexName) {
        var indexSchema = _.find(this._schema.indexes, function (index) { return index.name === indexName; });
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }
        return new SqlStoreIndex(this._trans, this._schema, indexSchema, this._supportsFTS3, this._verbose);
    };
    SqlStore.prototype.openPrimaryKey = function () {
        return new SqlStoreIndex(this._trans, this._schema, undefined, this._supportsFTS3, this._verbose);
    };
    SqlStore.prototype.clearAllData = function () {
        var _this = this;
        var indexes = _.filter(this._schema.indexes, function (index) { return indexUsesSeparateTable(index, _this._supportsFTS3); });
        var queries = _.map(indexes, function (index) {
            return _this._trans.internal_nonQuery('DELETE FROM ' + _this._schema.name + '_' + index.name);
        });
        queries.push(this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name));
        return SyncTasks.all(queries).then(_.noop);
    };
    SqlStore._unicodeFixer = new RegExp('[\u2028\u2029]', 'g');
    return SqlStore;
}());
// DbIndex implementation for SQL-based DbProviders.  Wraps all of the nasty compound key logic and general index traversal logic into
// the appropriate SQL queries.
var SqlStoreIndex = /** @class */ (function () {
    function SqlStoreIndex(_trans, storeSchema, indexSchema, _supportsFTS3, _verbose) {
        this._trans = _trans;
        this._supportsFTS3 = _supportsFTS3;
        this._verbose = _verbose;
        if (!indexSchema) {
            // Going against the PK of the store
            this._tableName = storeSchema.name;
            this._rawTableName = this._tableName;
            this._indexTableName = this._tableName;
            this._queryColumn = 'nsp_pk';
            this._keyPath = storeSchema.primaryKeyPath;
        }
        else {
            if (indexUsesSeparateTable(indexSchema, this._supportsFTS3)) {
                if (indexSchema.includeDataInIndex) {
                    this._tableName = storeSchema.name + '_' + indexSchema.name;
                    this._rawTableName = storeSchema.name;
                    this._indexTableName = storeSchema.name + '_' + indexSchema.name;
                    this._queryColumn = 'nsp_key';
                }
                else {
                    this._tableName = storeSchema.name + '_' + indexSchema.name + ' mi LEFT JOIN ' + storeSchema.name +
                        ' ON mi.nsp_refpk = ' + storeSchema.name + '.nsp_pk';
                    this._rawTableName = storeSchema.name;
                    this._indexTableName = storeSchema.name + '_' + indexSchema.name;
                    this._queryColumn = 'mi.nsp_key';
                }
            }
            else {
                this._tableName = storeSchema.name;
                this._rawTableName = this._tableName;
                this._indexTableName = this._tableName;
                this._queryColumn = 'nsp_i_' + indexSchema.name;
            }
            this._keyPath = indexSchema.keyPath;
        }
    }
    SqlStoreIndex.prototype._handleQuery = function (sql, args, reverse, limit, offset) {
        sql += ' ORDER BY ' + this._queryColumn + (reverse ? ' DESC' : ' ASC');
        if (limit) {
            if (limit > LimitMax) {
                if (this._verbose) {
                    console.warn('Limit exceeded in _handleQuery (' + limit + ')');
                }
                limit = LimitMax;
            }
            sql += ' LIMIT ' + limit.toString();
        }
        if (offset) {
            sql += ' OFFSET ' + offset.toString();
        }
        return this._trans.internal_getResultsFromQuery(sql, args);
    };
    SqlStoreIndex.prototype.getAll = function (reverse, limit, offset) {
        var _this = this;
        var startTime;
        if (this._verbose) {
            startTime = Date.now();
        }
        var promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName, undefined, reverse, limit, offset);
        if (this._verbose) {
            promise = promise.finally(function () {
                console.log('SqlStoreIndex (' + _this._rawTableName + '/' + _this._indexTableName + ') getAll: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    };
    SqlStoreIndex.prototype.getOnly = function (key, reverse, limit, offset) {
        var _this = this;
        var joinedKey;
        var err = _.attempt(function () {
            joinedKey = NoSqlProviderUtils.serializeKeyToString(key, _this._keyPath);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }
        var startTime;
        if (this._verbose) {
            startTime = Date.now();
        }
        var promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + this._queryColumn + ' = ?', [joinedKey], reverse, limit, offset);
        if (this._verbose) {
            promise = promise.finally(function () {
                console.log('SqlStoreIndex (' + _this._rawTableName + '/' + _this._indexTableName + ') getOnly: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    };
    SqlStoreIndex.prototype.getRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverse, limit, offset) {
        var _this = this;
        var checks;
        var args;
        var err = _.attempt(function () {
            var ret = _this._getRangeChecks(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
            checks = ret.checks;
            args = ret.args;
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }
        var startTime;
        if (this._verbose) {
            startTime = Date.now();
        }
        var promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + checks, args, reverse, limit, offset);
        if (this._verbose) {
            promise = promise.finally(function () {
                console.log('SqlStoreIndex (' + _this._rawTableName + '/' + _this._indexTableName + ') getRange: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    };
    // Warning: This function can throw, make sure to trap.
    SqlStoreIndex.prototype._getRangeChecks = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var checks = [];
        var args = [];
        if (keyLowRange !== null && keyLowRange !== undefined) {
            checks.push(this._queryColumn + (lowRangeExclusive ? ' > ' : ' >= ') + '?');
            args.push(NoSqlProviderUtils.serializeKeyToString(keyLowRange, this._keyPath));
        }
        if (keyHighRange !== null && keyHighRange !== undefined) {
            checks.push(this._queryColumn + (highRangeExclusive ? ' < ' : ' <= ') + '?');
            args.push(NoSqlProviderUtils.serializeKeyToString(keyHighRange, this._keyPath));
        }
        return { checks: checks.join(' AND '), args: args };
    };
    SqlStoreIndex.prototype.countAll = function () {
        var _this = this;
        var startTime;
        if (this._verbose) {
            startTime = Date.now();
        }
        var promise = this._trans.runQuery('SELECT COUNT(*) cnt FROM ' + this._tableName).then(function (result) { return result[0]['cnt']; });
        if (this._verbose) {
            promise = promise.finally(function () {
                console.log('SqlStoreIndex (' + _this._rawTableName + '/' + _this._indexTableName + ') countAll: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    };
    SqlStoreIndex.prototype.countOnly = function (key) {
        var _this = this;
        var joinedKey;
        var err = _.attempt(function () {
            joinedKey = NoSqlProviderUtils.serializeKeyToString(key, _this._keyPath);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }
        var startTime;
        if (this._verbose) {
            startTime = Date.now();
        }
        var promise = this._trans.runQuery('SELECT COUNT(*) cnt FROM ' + this._tableName + ' WHERE ' + this._queryColumn
            + ' = ?', [joinedKey]).then(function (result) { return result[0]['cnt']; });
        if (this._verbose) {
            promise = promise.finally(function () {
                console.log('SqlStoreIndex (' + _this._rawTableName + '/' + _this._indexTableName + ') countOnly: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    };
    SqlStoreIndex.prototype.countRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var _this = this;
        var checks;
        var args;
        var err = _.attempt(function () {
            var ret = _this._getRangeChecks(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
            checks = ret.checks;
            args = ret.args;
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }
        var startTime;
        if (this._verbose) {
            startTime = Date.now();
        }
        var promise = this._trans.runQuery('SELECT COUNT(*) cnt FROM ' + this._tableName + ' WHERE ' + checks, args)
            .then(function (result) { return result[0]['cnt']; });
        if (this._verbose) {
            promise = promise.finally(function () {
                console.log('SqlStoreIndex (' + _this._rawTableName + '/' + _this._indexTableName + ') countOnly: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    };
    SqlStoreIndex.prototype.fullTextSearch = function (searchPhrase, resolution, limit) {
        var _this = this;
        if (resolution === void 0) { resolution = NoSqlProvider.FullTextTermResolution.And; }
        var startTime;
        if (this._verbose) {
            startTime = Date.now();
        }
        var terms = FullTextSearchHelpers.breakAndNormalizeSearchPhrase(searchPhrase);
        if (terms.length === 0) {
            return SyncTasks.Resolved([]);
        }
        var promise;
        if (this._supportsFTS3) {
            if (resolution === NoSqlProvider.FullTextTermResolution.And) {
                promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + this._queryColumn + ' MATCH ?', [_.map(terms, function (term) { return term + '*'; }).join(' ')], false, limit);
            }
            else if (resolution === NoSqlProvider.FullTextTermResolution.Or) {
                // SQLite FTS3 doesn't support OR queries so we have to hack it...
                var baseQueries = _.map(terms, function (term) { return 'SELECT * FROM ' + _this._indexTableName + ' WHERE nsp_key MATCH ?'; });
                var joinedQuery = 'SELECT * FROM (SELECT DISTINCT * FROM (' + baseQueries.join(' UNION ALL ') + ')) mi LEFT JOIN ' +
                    this._rawTableName + ' t ON mi.nsp_refpk = t.nsp_pk';
                var args = _.map(terms, function (term) { return term + '*'; });
                promise = this._handleQuery(joinedQuery, args, false, limit);
            }
            else {
                return SyncTasks.Rejected('fullTextSearch called with invalid term resolution mode');
            }
        }
        else {
            var joinTerm = void 0;
            if (resolution === NoSqlProvider.FullTextTermResolution.And) {
                joinTerm = ' AND ';
            }
            else if (resolution === NoSqlProvider.FullTextTermResolution.Or) {
                joinTerm = ' OR ';
            }
            else {
                return SyncTasks.Rejected('fullTextSearch called with invalid term resolution mode');
            }
            promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' +
                _.map(terms, function (term) { return _this._queryColumn + ' LIKE ?'; }).join(joinTerm), _.map(terms, function (term) { return '%' + FakeFTSJoinToken + term + '%'; }));
        }
        if (this._verbose) {
            promise = promise.finally(function () {
                console.log('SqlStoreIndex (' + _this._rawTableName + '/' + _this._indexTableName + ') fullTextSearch: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    };
    return SqlStoreIndex;
}());
//# sourceMappingURL=SqlProviderBase.js.map