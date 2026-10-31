const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

function track({torch=false,failLight=false,ignoreLight=false}={}){
  return {stopped:0,light:false,requests:[],events:{},
    stop(){this.stopped++;},addEventListener(n,f){this.events[n]=f;},
    getCapabilities(){return {torch};},getSettings(){return {torch:this.light};},
    async applyConstraints(c){this.requests.push(c);if(failLight)throw Error('Unavailable');if(!ignoreLight)this.light=c.advanced[0].torch;}
  };
}
function stream(t){return {getTracks:()=>[t],getVideoTracks:()=>[t]};}
function harness(options={}){
  const t=options.track||track(),requests=[],scans=[],events={},timers=new Map();let tid=0;
  const video={srcObject:null,videoWidth:900,videoHeight:1000,readyState:4,paused:0,addEventListener(){},play:async()=>{},pause(){this.paused++;}};
  const elements={'receipt-camera':video,'capture-photo':{disabled:true},'camera-in':{clicks:0,click(){this.clicks++;}},'file-in':{click(){}}};
  const document={hidden:false,getElementById:id=>elements[id]||{},addEventListener:(n,f)=>events[n]=f,
    createElement:()=>({getContext:()=>({drawImage(){if(options.onFrame)options.onFrame(t);}}),toBlob:cb=>{if(options.frameError)throw Error('Frame failed');cb({type:'image/jpeg',size:345});}})};
  const window={isSecureContext:options.secure!==false,addEventListener:(n,f)=>events[n]=f,
    navigator:{mediaDevices:{getUserMedia:async c=>{requests.push(c);return options.getUserMedia?options.getUserMedia(c):stream(t);}}}};
  if(options.flash){
    window.ImageCapture=class {
      async getPhotoCapabilities(){return {fillLightMode:['off','flash']};}
      async takePhoto(settings){options.photoSettings=settings;if(options.photo) return options.photo(settings);return {type:'image/jpeg',size:123};}
    };
  }
  const context={window,document,console,localStorage:{getItem:()=>null,setItem(){}},
    File:class {constructor(parts,name,opts){this.name=name;this.type=opts.type;this.size=parts[0].size;}},
    setTimeout:(f,ms)=>{const id=++tid;if(ms===250)Promise.resolve().then(f);else timers.set(id,f);return id;},clearTimeout:id=>timers.delete(id)};
  context.scans=scans;
  vm.runInNewContext(script.replace("if (!V[S.view]", "render=()=>{};runScan=async file=>scans.push(file);globalThis.api={openCamera,stopCamera,toggleCameraLight,captureCameraPhoto,attachCameraPreview,go,S,ui,A};return;\nif (!V[S.view]"),context);
  return {api:context.api,t,video,elements,requests,scans,events,document,timers};
}

test('opens a portrait rear-camera stream with no audio and keeps the preview light off',async()=>{
  const h=harness({track:track({torch:true})});await h.api.openCamera();
  assert.equal(h.requests[0].audio,false);assert.equal(h.requests[0].video.facingMode.ideal,'environment');
  assert.equal(h.api.ui.cameraOpen,true);assert.equal(h.api.ui.cameraLoading,false);
  assert.equal(h.requests[0].video.aspectRatio.ideal,3/4);
  assert.equal(h.t.light,false);assert.equal(h.t.requests.length,0);assert.equal(h.api.ui.cameraFlashEnabled,true);
  h.api.attachCameraPreview();await Promise.resolve();
  assert.ok(h.video.srcObject);assert.equal(h.video.muted,true);assert.equal(h.elements['capture-photo'].disabled,false);
  await h.api.toggleCameraLight();assert.equal(h.t.light,false);assert.equal(h.t.requests.length,0);
  assert.equal(h.api.ui.cameraFlashEnabled,false);
  h.api.stopCamera();assert.equal(h.t.stopped,1);assert.equal(h.video.srcObject,null);assert.equal(h.video.paused,1);
});

test('an unsupported or rejected light does not prevent camera use',async()=>{
  for(const t of [track(),track({torch:true,failLight:true}),track({torch:true,ignoreLight:true})]){
    const h=harness({track:t});await h.api.openCamera();
    assert.equal(h.api.ui.cameraOpen,true);assert.equal(h.api.ui.cameraLoading,false);assert.equal(t.light,false);
    h.api.stopCamera();assert.equal(t.stopped,1);
  }
});

test('insecure contexts retain the native photo picker without requesting a stream',async()=>{
  const h=harness({secure:false}),draft=h.api.S.draft;await h.api.openCamera();
  assert.equal(h.requests.length,0);assert.equal(h.elements['camera-in'].clicks,1);assert.equal(h.api.S.draft,draft);
});

test('permission denial leaves the draft intact with a fallback message',async()=>{
  const error=Object.assign(Error('denied'),{name:'NotAllowedError'});
  const h=harness({getUserMedia:async()=>{throw error;}}),draft=h.api.S.draft;
  await h.api.openCamera();assert.equal(h.api.ui.cameraOpen,false);
  assert.match(h.api.ui.cameraError,/not allowed/);assert.equal(h.api.S.draft,draft);
});

test('closing a pending camera request stops the late stream and does not reopen it',async()=>{
  const ready=deferred(),t=track(),h=harness({track:t,getUserMedia:()=>ready.promise});
  const opening=h.api.openCamera();h.api.A.closeCamera();ready.resolve(stream(t));await opening;
  assert.equal(t.stopped,1);assert.equal(h.api.ui.cameraOpen,false);
});

test('leaving the view, hiding the tab or unloading releases all camera tracks',async()=>{
  for(const action of ['navigate','hide','unload']){
    const h=harness();await h.api.openCamera();
    if(action==='navigate')h.api.go('home');
    if(action==='hide'){h.document.hidden=true;h.events.visibilitychange();}
    if(action==='unload')h.events.pagehide();
    assert.equal(h.t.stopped,1,action);assert.equal(h.api.ui.cameraOpen,false,action);
  }
});

test('a video-frame capture stops the camera before passing a real file to the scanner',async()=>{
  const h=harness();await h.api.openCamera();await h.api.captureCameraPhoto();
  assert.equal(h.scans.length,1);assert.equal(h.scans[0].type,'image/jpeg');assert.equal(h.scans[0].size,345);
  assert.equal(h.t.stopped,1);assert.equal(h.api.ui.cameraOpen,false);
});

test('still-photo flash fires only at capture and supports a manual off choice',async()=>{
  for(const enabled of [true,false]){
    const options={flash:true},h=harness(options);await h.api.openCamera();
    assert.equal(h.api.ui.cameraLightMode,'flash');assert.equal(h.api.ui.cameraFlashEnabled,true);assert.equal(h.t.light,false);
    if(!enabled)await h.api.toggleCameraLight();
    await h.api.captureCameraPhoto();assert.equal(options.photoSettings.fillLightMode,enabled?'flash':'off');
    assert.equal(h.scans[0].size,123);assert.equal(h.t.stopped,1);
  }
});

test('Start split opens the camera directly even with an existing draft; closing preserves it',async()=>{
  const h=harness(),draft=h.api.S.draft;draft.items=[{id:'old',name:'Previous meal',price:123}];
  await h.api.A.start();assert.equal(h.requests.length,1);assert.equal(h.api.ui.cameraOpen,true);
  h.api.A.closeCamera();assert.equal(h.api.S.draft,draft);assert.equal(draft.items[0].price,123);
  h.api.A.resume();assert.equal(h.api.S.view,'review');
});

test('torch-only devices pulse light for the captured frame and turn it off before OCR',async()=>{
  for(const enabled of [true,false]){
    const t=track({torch:true}),h=harness({track:t,onFrame:()=>assert.equal(t.light,enabled)});
    await h.api.openCamera();assert.equal(t.light,false);
    if(!enabled)await h.api.toggleCameraLight();
    await h.api.captureCameraPhoto();
    assert.equal(h.scans.length,1);assert.equal(t.light,false);assert.equal(t.stopped,1);
    assert.equal(t.requests.length,enabled?2:0);
  }
});

test('torch or frame failures leave no light on and retain the existing draft',async()=>{
  for(const mode of ['rejected','ignored','frame']){
    const t=track({torch:true,failLight:mode==='rejected',ignoreLight:mode==='ignored'});
    const h=harness({track:t,frameError:mode==='frame'}),draft=h.api.S.draft;
    await h.api.openCamera();await h.api.captureCameraPhoto();
    assert.equal(h.scans.length,0);assert.equal(h.api.S.draft,draft);assert.equal(t.light,false);
    assert.ok(h.api.ui.cameraError);h.api.stopCamera();
  }
});

test('failed flash capture offers native capture rather than silently taking an unlit frame',async()=>{
  const h=harness({flash:true,photo:async()=>{throw Error('Unsupported');}});await h.api.openCamera();
  await h.api.captureCameraPhoto();assert.equal(h.scans.length,0);assert.equal(h.api.ui.cameraOpen,true);
  assert.match(h.api.ui.cameraError,/Flash capture did not work/);h.api.stopCamera();
});

test('a photo finishing after the user closes the camera cannot replace the draft',async()=>{
  const ready=deferred(),h=harness({flash:true,photo:()=>ready.promise}),draft=h.api.S.draft;
  await h.api.openCamera();const capturing=h.api.captureCameraPhoto();h.api.A.closeCamera();
  ready.resolve({type:'image/jpeg',size:123});await capturing;
  assert.equal(h.scans.length,0);assert.equal(h.api.S.draft,draft);assert.equal(h.t.stopped,1);
});
