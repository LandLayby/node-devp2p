var util = require('util'),
  assert = require('assert'),
  EventEmitter = require('events').EventEmitter,
  rlp = require('rlp'),
  logic = require('./logic.js'),
  codes = require('./codes.js');

/**
 * @contructor
 * @param {Object} socket an Intialized Sockets. MUST alread be connected
 * @param {Object} network the network that initailized the connection
 */
var Peer = exports = module.exports = function(socket, network) {
  // Register as event emitter
  EventEmitter.call(this);

  this.socket = socket;
  this.network = network;

  //the state of the peer
  this._state = {
    hello: false, //has the handshake took place?
    sentPeers: false,
    gettingPeers: false,
    wantPeers: false
  };

  var self = this;
  socket.on('error', function(e) {
    self.emit('socet.error', e);
  });

  var data = new Buffer([]);

  //defines the packet parsing behavoir
  socket.on('data', function(newData) {

    data = Buffer.concat([data, newData]);
    var more = true;

    while (more) {
      var parsedData = false,
        subProtocol,
        command;

      try {
        var payloadLen = parseInt(data.slice(4, 8).toString('hex'), 16);

        if (payloadLen > data.length + 8) {
          more = false;
        } else {
          var d = data.slice(8, payloadLen + 8);
          var payload = rlp.decode(d);

          assert.equal(codes.syncToken, data.slice(0, 4).toString('hex'), 'Invalid Sync Token');
          data = data.slice(payloadLen + 8);

          var commandCode =  payload[0][0];
          if(!commandCode){
            commandCode = 0;
          }

          command = codes.command[commandCode];

          var result = self._parsePayload(command, payload);
          parsedData = result[1];
          subProtocol = result[0];


          if (data.length === 0) {
            more = false;
          }
        }
      } catch (e) {
        more = false; //stop the while
        data = new Buffer([]);
        self.emit('parsing.error', e);
        self.disconnect(0x02);
      }

      if (parsedData) {

        //emit events
        if(subProtocol !== ''){
          subProtocol = subProtocol + '.';
        }

        var eventData = [subProtocol + command, parsedData, self];
        self.emit.apply(self, eventData);

        //broadcast on network
        self.network.emit.apply(self.network, eventData);

        //broadcast event to peer for type `message`
        eventData[0] = command;
        eventData.unshift('message');
        self.emit.apply(self, parsedData);
      }
    }
  });


  //bind subProtocol methods
  for (var cap in this.network.capabilities) {
    for (var method in this[cap]) {
      this[cap][method] = this[cap][method].bind(this);
    }
  }

  //bind the peer logic
  logic.logic(this);
};

util.inherits(Peer, EventEmitter);

/**
 * formats packets as a 4-byte synchronisation token (0x22400891), a 4-byte
 * 'payload size', to be interpreted as a big-endian integer and finally an
 * N-byte rlp-serialised data structure, where N is the aforementioned
 * 'payload size'.
 * @method sendMessage
 * @param {Object} message a the message that is being sent
 * @param {Function} cb a callback function
 */
Peer.prototype.sendMessage = function(message, cb) {
  var payload = rlp.encode(message),
    len = new Buffer(4);

  len.writeUInt32BE(payload.length, 0);
  var formatedPayload = Buffer.concat([new Buffer(codes.syncToken, 'hex'), len, payload]);
  this.socket.write(formatedPayload, cb);
};

Peer.prototype._parsePayload = function(command, payload) {

  var code = codes.code[command],
    parseFunc = this.network._parseFuncs[code];

  if (parseFunc) {
    return parseFunc.bind(this)(payload);
  } else {
    throw ('invalid message id');
  }
};

Peer.addSubFunctions = function(def) {

  var root;
  var method;
  var name = def.meta.name;

  if (name) {
    root = Peer.prototype[name] = {};
  } else {
    name = '';
    root = Peer.prototype;
  }

  for(method in def.methods){
    root[method] = function(method){
      return function(){
        def.methods[method].apply(this, arguments);
      };
    }(method, name);
  }

  //attaches the sending functions to the subprotocol object
  for (var os in def.offsets) {
    method = def.offsets[os];

    //first function creates an enclosure
    root[method] = function(method, name) {
      return function() {
        var func = def.send[method];

        //if there is no sending definition for a message type then use this
        //function
        if (typeof func !== 'function') {
          func = function() {
            return [];
          };
        }

        var onDone = false;
        var cb = arguments[arguments.length - 1];
        if (typeof cb !== 'function') {
          cb = function() {};
        }

        cb = function() {
          if (onDone) onDone();
        };

        [].push.call(arguments, function(doneFunc) {
          onDone = doneFunc;
        });

        //run the function
        var message = func.apply(this, arguments);
        var offset = this.network._messageOffsets[name + method];
        message.unshift(offset);

        this.sendMessage(message, cb);
      };
    }(method, name);
  }
};

Peer.prototype.toString = function() {
  return this.socket.remoteAddress + ':' + this.socket.remotePort;
};
