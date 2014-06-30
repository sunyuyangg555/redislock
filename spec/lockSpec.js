var expect    = require('expect.js');
var Promise   = require('bluebird');
var fakeredis = require('fakeredis');
var helpers   = require('./redisHelpers');
var redislock = require('../lib/redislock');
var Lock      = require('../lib/lock');

var LockAcquisitionError = redislock.LockAcquisitionError;
var LockReleaseError     = redislock.LockReleaseError;

// Fakeredis doesn't support SET options such as PX and NX
var client = fakeredis.createClient(6379, '0.0.0.0', {fast: true});
helpers.addSetOptions(client);
Promise.promisifyAll(client);

describe('lock', function() {
  describe('constructor', function() {
    var lock;

    beforeEach(function() {
      lock = new Lock(client);
    });

    it('assigns the lock a UUID id', function() {
      var altLock = new Lock(client);

      expect(lock.id).to.have.length(36);
      expect(lock.id).not.to.be(altLock.id);
    });

    it('creates the lock with a null key, and locked set to false', function() {
      expect(lock.key).to.be(null);
      expect(lock.locked).to.be(false);
    });

    it('stores the redis client in its _client property', function() {
      expect(lock._client).to.be(client);
    });

    it('promisifies all required methods of the redis client', function() {
      var client = fakeredis.createClient(6379, '0.0.0.0', {fast: true});
      var lock = new Lock(client);

      expect(client).to.have.property('getAsync');
      expect(client).to.have.property('setAsync');
      expect(client).to.have.property('watchAsync');
    });

    it('sets properties to their defaults if not supplied', function() {
      expect(lock.timeout).to.be(Lock._defaults.timeout);
      expect(lock.retries).to.be(Lock._defaults.retries);
      expect(lock.delay).to.be(Lock._defaults.delay);
    });

    it('sets properties for any valid options', function() {
      var options = {
        timeout: 999,
        retries: 888,
        delay: 777
      };

      var lock = new Lock(client, options);

      expect(lock.timeout).to.be(options.timeout);
      expect(lock.retries).to.be(options.retries);
      expect(lock.delay).to.be(options.delay);
    });
  });

  describe('acquire', function() {
    var lock;

    // Used to replace a Lock's release method
    var mockRelease = function(lock) {
      lock.release = function(fn) {
        delete Lock._acquiredLocks[lock.id];
        return client.delAsync(lock.key).nodeify(fn);
      };
    };

    beforeEach(function() {
      lock = new Lock(client);
      mockRelease(lock);
    });

    afterEach(function(done) {
      if (lock.key) {
        mockRelease(lock);
        lock.release(done);
      } else {
        done();
      }
    });

    it('is compatible with promises', function(done) {
      lock.acquire('promisetest', function() {
        return lock.release();
      }).then(function() {
        done();
      }).catch(function(e) {
        done(e);
      });
    });

    it('is compatible with callbacks', function(done) {
      lock.acquire('callbacktest', function(err) {
        if (err) return done(err);

        lock.release(function(err) {
          if (err) return done(err);
          done();
        });
      });
    });

    it('returns a LockAcquisitionError if already locked', function(done) {
      lock.acquire('test:key').then(function() {
        return lock.acquire('test:key');
      }).catch(LockAcquisitionError, function(err) {
        expect(err).to.be.an(LockAcquisitionError);
        expect(err.message).to.be('Lock already held');
        done();
      });
    });

    it('returns an error if retries is 0, and the key is not empty',function(done) {
      client.setAsync('key:taken', 'aLockID').then(function() {
        return lock.acquire('key:taken');
      }).catch(LockAcquisitionError, function(err) {
        expect(err).to.be.an(LockAcquisitionError);
        expect(err.message).to.be('Could not acquire lock on key:taken');
        done();
      });
    });

    it('sets the locked property to true', function(done) {
      lock.acquire('test:key').then(function() {
        expect(lock.locked).to.be(true);
        done();
      });
    });

    it('sets its key property to the given key', function(done) {
      var key = 'test:key';
      lock.acquire(key).then(function() {
        expect(lock.key).to.be(key);
        done();
      });
    });

    it('retries with the configured delay', function(done) {
      // Bluebird.delay doesn't seem to play well with sinon time faking
      // As a result, this test works, but is more fragile than I'd like
      var key = 'retry:test';
      lock = new Lock(client, {
        timeout: 10000,
        retries: 1,
        delay:   10
      });

      setTimeout(function() {
        client.del(key);
      }, 9);

      client.setAsync(key, 'testID').then(function(res) {
        return lock.acquire(key);
      }).then(done);
    });
  });
});
