var fs = require("fs");
var path = require("path");
var ipc = require('node-ipc');
var Service = require('node-windows').Service;

ipc.config.id = 'server';
ipc.config.retry = 2000;
ipc.config.silent = true;
ipc.config.maxRetries = 2;

module.exports = function(opts){

    var modules = {};
    // Config for Windows service
    var agentPrefix         = opts.prefix;  //"Agent";
    var agentDescPrefix     = opts.description;  //"Agent";
    var agentScript         = opts.script;  //path.join(__dirname, 'serviceAgent.js'),
    var agentFolder         = opts.folder || path.join(process.cwd(), 'agents');
    try{
        fs.mkdirSync(agentFolder);
    }catch(e){}

    if(opts.ipcConfig){
        for(var setting in opts.ipcConfig){
            ipc.config[setting] = opts.ipcConfig[setting];
        }
    }
    /**********************************************************************
     * Windows Agents
     **********************************************************************/
    modules.configureAgent = function(win_config, next){
        // var agentName = "Agent";
        var daemonDir =  path.join(agentFolder, win_config.agentId);
        try{
            fs.mkdirSync(daemonDir);
        }catch(e){}
        
        // Create a new service object
        var svc = new Service({
          name: agentPrefix + win_config.username,
          description: agentDescPrefix + win_config.username,
        //   script: path.join(__dirname, 'serviceAgent.js'),
          script: agentScript,
          env: [{
            name: "agentId",
            value: win_config.agentId
          }]
        });
        
        // Set a directory per agent
        svc._directory = daemonDir;
        
        svc.on('error',function(err){
            return next(err);
        });
        return next(null, svc);
    };
    
    // Test if an agent is online,
    // Return (err, agentId)
    modules.install = function(win_config, password, next){
        if(typeof password === 'function'){
            next        =   password;
            password    =   false;
        }
    
        modules.configureAgent(win_config, function(err, service){
            if(err){
                return next(err);
            }
            var once = true;
            var daemonXmlFile = path.join(service._directory, "daemon", service.name + '.xml');
            
            if(password){
                service.logOnAs.domain = win_config.domain;
                service.logOnAs.account = win_config.username;
                service.logOnAs.password = password;
            }
            
            // Listen for the "install" event, which indicates the
            // process is available as a service.
            service.on('install',function(){
                //Start the service if password was provided
                if(password){
                    service.start();
                }else{
                    return next(null);
                }
            });
        
            service.on('start',function(){
                if(once){
                    once = false;
                    // Delete password from file
                    fs.readFile(daemonXmlFile, 'utf8', function(err, xmlContent){
                        if(err){
                           return next(err);
                        }else{
                            // Supress password
                            xmlContent = xmlContent.replace(
                                /<password>.+?<\/password>/g,
                                "<password>XXXXXX</password>");
                            // Rewrite
                            fs.writeFile(daemonXmlFile, xmlContent, 'utf8', function(err){
                                if(err){
                                    return next(err);
                                }else{
                                    // Success
                                    return next(null);
                                }
                            });
                        }
                    });
                }
            });
            
            service.on('error',function(err){
                return next(err);
            });
                
            //Install and start
            service.install();
        });
    };
    
    modules.exists = function(win_config, next){
        modules.configureAgent(win_config, function(err, service){
            if(err){
                return next(err);
            }
            // Verify existence
            if(service.exists){
                return next(null);
            }else{
                return next(new Error('Agent is not installed.'));
            }
        });
    };
    
    modules.start = function(win_config, next){
        modules.configureAgent(win_config, function(err, service){
            if(err){
                return next(err);
            }
            var once = true;
            
            // Listen for the "uninstall" event so we know when it's done.
            service.on('start',function(){
                // Uninstall the service.
                if(once){
                    once = false;
                    next();
                }
            });
            // Start service
            service.start();
        });
    };
    
    modules.stop = function(win_config, next){
        modules.configureAgent(win_config, function(err, service){
            if(err){
                return next(err);
            }
            var once = true;
            
            // Listen for the "stop" event
            service.on('stop',function(){
                // Uninstall the service.
                if(once){
                    once = false;
                    return next();
                }
            });
            // Stop service
            service.stop();
        });
    };
    
    modules.restart = function(win_config, next){
        modules.configureAgent(win_config, function(err, service){
            if(err){
                return next(err);
            }
            var onceStop = true;
            var onceStart = true;
            
            // Listen for the "stop" event
            service.on('stop',function(){
                // Uninstall the service.
                if(onceStop){
                    onceStop = false;
                    setTimeout(function(){
                        // Start service
                        service.start();
                    },2000);
                }
            });
            
            // Listen for the "uninstall" event so we know when it's done.
            service.on('start',function(){
                // Uninstall the service.
                if(onceStart){
                    onceStart = false;
                    next();
                }
            });
            
            // Stop service
            service.stop();
        });
    };
    
    
    modules.uninstall = function(win_config, next){
        modules.configureAgent(win_config, function(err, service){
            if(err){
                return next(err);
            }
            var once = true;
        
            // Listen for the "stop" event
            service.on('stop',function(){
                // Uninstall the service.
                if(once){
                    once = false;
                    service.uninstall();
                }
            });
            
            // Listen for the "uninstall" event
            service.on('uninstall',function(){
                // Success
                return next(null);
            });
            
            // Stop and uninstall
            service.stop();
        });
    };
    
    /**********************************************************************
     * IPC Messages
     **********************************************************************/
    // Submit job to an agent by jobfile
    modules.submit = function(win_config, jobWorkingDir, jobFile, next){
        
        // Connect to AgentId        
        ipc.connectTo(win_config.agentId,function(){
            //On Connect, send action
            ipc.of[win_config.agentId].on('connect',function(){
                ipc.of[win_config.agentId].emit('action',
                    {
                        win_config      :   win_config,
                        jobWorkingDir   :   jobWorkingDir,
                        jobfile         :   jobFile
                    }
                );
            });
            ipc.of[win_config.agentId].on('answer',function(data){
                ipc.disconnect(win_config.agentId);
                return next(null, data);
            });
            ipc.of[win_config.agentId].on('error', function(err){
                if(err.code === 'ENOENT'){
                    return next(new Error('Agent is unreachable.'));
                }else{
                    return next(err);
                }
            });
        });
    };
    
    
    // Test if an agent is online,
    // Return (err, {agentId, username})
    modules.ping = function(win_config, next){
        // Count ping-ping, destroy event is emitted even if it works
        var pingPongTest = 0;
        // Connect to AgentId        
        ipc.connectTo(win_config.agentId,function(){
            //Send ping, listen for pong
            ipc.of[win_config.agentId].on('connect',function(){
                ipc.of[win_config.agentId].emit('ping');
            });
            ipc.of[win_config.agentId].on('pong',function(data){
                ipc.disconnect(win_config.agentId);
                return next(null, data);
            });
            ipc.of[win_config.agentId].on('error', function(err){
                if(err.code === 'ENOENT'){
                    pingPongTest++;
                    if(pingPongTest === ipc.config.maxRetries){
                        return next(new Error('Agent is unreachable.'));
                    }
                }else{
                    return next(err);
                }
            });
        });
    };

    // END
    return modules;
};