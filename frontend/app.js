(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const api = () => window.PRESIDENTIAL_AUTH && window.PRESIDENTIAL_AUTH.api;
  let currentPayload = null, currentGame = null, draftId = null, busy = false;
  let selectedMinisterCandidate = null;
  let militaryMapView = { scale: 1, x: 0, y: 0 };
  let militaryMapLayer = null;
  let militaryMapState = { mode: "view", draft: [], justDragged: false };
  let militaryLeafletMap=null;
  let militaryLeafletOverlay=null;
  let militaryLeafletRoot=null;
  let militaryLeafletSaveKey="";
  let militaryLeafletWarKey="";
  let militaryLeafletDefaultView={center:[20,0],zoom:2};

  const decreeCache = new Map();

  const OUTBOX_PREFIX="presidential.ai.outbox.v1.";
  const DRAFT_PREFIX="presidential.localdraft.v1.";
  let outboxOwner=null,outbox=[],outboxRunning=false;
  const outboxCallbacks=new Map();

  function localOwnerId(){
    const user=window.PRESIDENTIAL_AUTH&&window.PRESIDENTIAL_AUTH.user||{};
    return String(user.telegramId||user.id||user.userId||user.username||user.firstName||"player");
  }
  function outboxStorageKey(){return OUTBOX_PREFIX+encodeURIComponent(outboxOwner||localOwnerId());}
  function localDraftKey(field){return DRAFT_PREFIX+encodeURIComponent(localOwnerId())+"."+String(field);}
  function activeSaveId(){return String(currentGame&&(currentGame.id||currentGame.save_id||currentGame.saveId)||"");}
  function initializeOutbox(){
    if(!window.PRESIDENTIAL_AUTH||!window.PRESIDENTIAL_AUTH.user)return false;
    const owner=localOwnerId();
    if(outboxOwner===owner)return true;
    outboxOwner=owner;
    try{
      const stored=JSON.parse(localStorage.getItem(outboxStorageKey())||"[]");
      outbox=Array.isArray(stored)?stored.filter(item=>item&&item.id&&item.route&&item.payload&&typeof item.payload==="object"):[];
      let changed=false;
      outbox.forEach(item=>{
        if(item.status==="sending"){
          item.status="failed";item.recovered=true;
          item.error="Предыдущая отправка прервалась. Проверьте историю: сервер мог уже принять запрос. Повторяйте только если результата нет.";
          changed=true;
        }
      });
      if(changed)persistOutbox();
    }catch(error){console.warn("Local AI queue could not be restored:",error);outbox=[];}
    updateOutboxIndicator();return true;
  }
  function persistOutbox(){
    if(!outboxOwner)throw new Error("Не удалось определить локальную учётную запись.");
    try{localStorage.setItem(outboxStorageKey(),JSON.stringify(outbox));}
    catch(error){throw new Error("Браузер не смог сохранить запрос локально. Освободите место в хранилище и повторите.");}
    updateOutboxIndicator();
  }
  function hasPendingBackgroundJobs(){return outbox.some(item=>item.status==="queued"||item.status==="sending");}
  function updateOutboxIndicator(){
    let host=$("backgroundQueueStatus");
    if(!host){
      const save=$("saveStatus"),parent=save&&save.parentElement;
      if(parent){
        host=node("small","background-queue-status");host.id="backgroundQueueStatus";
        host.setAttribute("role","status");host.setAttribute("aria-live","polite");
        host.style.cssText="display:block;margin:6px 0 0 22px;font-size:11px;color:#64748b";
        parent.append(host);
        const retry=node("button","background-queue-retry","Повторить");
        retry.type="button";retry.id="backgroundQueueRetry";retry.hidden=true;
        retry.style.cssText="margin:4px 0 0 22px;padding:3px 7px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#334155;font-size:11px;cursor:pointer";
        retry.addEventListener("click",retryFailedBackgroundJobs);parent.append(retry);
      }
    }
    const active=outbox.filter(item=>item.status==="queued"||item.status==="sending");
    const failed=outbox.filter(item=>item.status==="failed"||item.status==="blocked");
    const running=active.some(item=>item.status==="sending");
    if(host){
      host.hidden=!active.length&&!failed.length;
      host.textContent=failed.length
        ?"Не отправлено: "+failed.length+" · запросы сохранены на устройстве"
        :running?"Фоновая обработка · в очереди "+active.length
        :"Сохранено локально · в очереди "+active.length;
    }
    const retry=$("backgroundQueueRetry");
    if(retry){retry.hidden=!failed.some(item=>item.status==="failed");retry.disabled=outboxRunning;retry.textContent=failed.filter(item=>item.status==="failed").length>1?"Повторить запросы ("+failed.filter(item=>item.status==="failed").length+")":"Повторить запрос";}
    let discard=$("backgroundQueueDiscard");
    if(!discard&&host&&host.parentElement){
      discard=node("button","background-queue-discard","Удалить сохранённые запросы");
      discard.type="button";discard.id="backgroundQueueDiscard";
      discard.style.cssText="margin:4px 0 0 6px;padding:3px 7px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#64748b;font-size:11px;cursor:pointer";
      discard.addEventListener("click",discardBlockedBackgroundJobs);host.parentElement.append(discard);
    }
    if(discard){discard.hidden=!failed.length;discard.disabled=outboxRunning;}
    const pending=active.length>0;
    document.querySelectorAll("[data-campaign-event-start],[data-campaign-event-respond],[data-election-proposal],[data-election-activity]").forEach(button=>button.disabled=busy||pending);
    if(busy||pending){
      document.querySelectorAll("[data-program-start],[data-program-cancel],[data-dismiss-minister]").forEach(button=>button.disabled=true);
      const politicalSubmit=$("politicalActionSubmit"),politicalInput=$("politicalActionInput");
      if(politicalSubmit)politicalSubmit.disabled=true;
      if(politicalInput)politicalInput.disabled=true;
    }
    const advance=$("advanceTurn"),newGame=$("newGame"),vote=$("electionVote");
    if(advance&&currentGame)advance.disabled=busy||pending||["election_campaign","election"].includes(currentGame.state&&currentGame.state.phase);
    if(newGame)newGame.disabled=busy||pending;
    if(vote)vote.disabled=busy||pending||vote.classList.contains("hidden")||vote.textContent.includes("Сначала")||Boolean(currentGame&&currentGame.state&&currentGame.state.campaignEvent&&currentGame.state.campaignEvent.status==="active");
  }
  function bindLocalDraft(element,field){
    if(!element||element.dataset.localDraftBound==="true")return;
    const key=localDraftKey(field);
    try{const saved=localStorage.getItem(key);if(saved!==null&&(!element.value||!element.value.trim()))element.value=saved;}catch(_){}
    element.dataset.localDraftBound="true";
    element.addEventListener("input",()=>{
      try{if(element.value)localStorage.setItem(key,element.value);else localStorage.removeItem(key);}
      catch(error){console.warn("Could not save local draft:",error);}
    });
  }
  function clearLocalDraft(field){try{localStorage.removeItem(localDraftKey(field));}catch(_){}}
  function clearAllLocalDrafts(){
    ["campaignProposal","campaignActivityInput","politicalActionInput","aiDiplomacyInput","order","amendmentText","amendmentReason","referendumQuestion"].forEach(clearLocalDraft);
  }
  function savedDecreeDraftKey(){return DRAFT_PREFIX+encodeURIComponent(localOwnerId())+".decree";}
  function getSavedDecreeDraft(){
    try{
      const value=JSON.parse(localStorage.getItem(savedDecreeDraftKey())||"null");
      if(value&&value.decree&&(!value.saveId||!activeSaveId()||value.saveId===activeSaveId()))return value.decree;
    }catch(_){}
    return null;
  }
  function saveDecreeDraft(decree){
    try{localStorage.setItem(savedDecreeDraftKey(),JSON.stringify({saveId:activeSaveId(),decree}));}
    catch(error){console.warn("Could not store generated decree locally:",error);}
  }
  function enqueueBackgroundTask({kind,route,payload,client="ai"}){
    if(!initializeOutbox())throw new Error("Необходимо войти через Telegram.");
    if(outbox.length>=40)throw new Error("Локальная очередь заполнена. Дождитесь завершения предыдущих запросов.");
    const item={
      id:(window.crypto&&crypto.randomUUID)?crypto.randomUUID():"job-"+Date.now()+"-"+Math.random().toString(36).slice(2),
      kind,client,route,payload,saveId:activeSaveId(),
      createdAt:new Date().toISOString(),status:"queued"
    };
    outbox.push(item);
    try{persistOutbox();}
    catch(error){outbox=outbox.filter(entry=>entry.id!==item.id);throw error;}
    toast("Информация сохранена на устройстве и поставлена в фоновую очередь.");
    setTimeout(()=>void startBackgroundQueue(),0);return item.id;
  }
  async function handleBackgroundSuccess(item,result){
    try{
      if(item.kind==="decree-draft"&&result&&result.decree){
        draftId=result.decree.id;saveDecreeDraft(result.decree);fillOfficialDocument(result.decree,false);
        toast("Проект указа готов. Он сохранён; проверьте документ в окне указа.");return;
      }
      if(item.kind==="diplomatic-message"&&activeDiplomacyRelation===item.payload.relationId){
        await loadAiDiplomacyHistory(item.payload.relationId);toast("Ответ иностранного лидера получен.");return;
      }
      if(item.kind==="election-position"){toast("Политическая позиция проанализирована и внесена в программу.");return;}
      if(item.kind==="election-activity"){toast("Действие кампании обработано. Разбор и реакция избирателей сохранены.");return;}
      if(item.kind==="campaign-event-start"){
        const event=result&&result.event;
        toast(event?"Началось мероприятие: "+(event.title||"вопрос готов")+". Ответьте на вопрос в открытой сессии.":"Мероприятие подготовлено.");
        return;
      }
      if(item.kind==="campaign-event-respond"){
        if(result&&result.complete)toast("Мероприятие завершено. Итоги и реакция аудитории сохранены в истории кампании.");
        else toast("Ответ принят. Следующий вопрос уже ожидает вас.");
        return;
      }
      if(item.kind==="presidential-action"){
        const coup=result&&result.coup;
        toast(coup?(coup.success?"Попытка переворота удалась. Последствия отражены в истории действий.":"Попытка переворота провалилась. Последствия отражены в истории действий."):"Президентское действие обработано и внесено в историю.");
        return;
      }
      if(item.kind==="decree-publish"){
        draftId=null;try{localStorage.removeItem(savedDecreeDraftKey());}catch(_){}
        if($("decreeDialog")&&$("decreeDialog").open)$("decreeDialog").close();
        toast("Указ опубликован. Исполнение программы началось.");return;
      }
      if(item.kind==="game-request")toast("Сохранённое действие выполнено. Данные государства обновлены.");
    }catch(error){console.warn("Background task result could not be rendered:",error);}
  }
  async function startBackgroundQueue(){
    if(outboxRunning||!initializeOutbox())return;
    const auth=window.PRESIDENTIAL_AUTH;
    const newCampaignQueued=outbox.some(item=>(item.status==="queued"||item.status==="failed")&&item.route==="/api/presidential/game/new");
    if(!auth||!auth.api||!auth.aiApi||(!currentGame&&!newCampaignQueued))return;
    outboxRunning=true;updateOutboxIndicator();
    try{
      while(true){
        const item=outbox.find(entry=>entry.status==="queued");
        if(!item)break;
        const itemIndex=outbox.findIndex(entry=>entry.id===item.id);
        const saveId=activeSaveId();
        if((item.route!=="/api/presidential/game/new"&&item.saveId&&item.saveId!==saveId)||(!currentGame&&item.route!=="/api/presidential/game/new")){
          item.status="blocked";item.error="Кампания уже изменилась или завершилась. Запрос сохранён, но не отправлен в другое сохранение.";
          persistOutbox();continue;
        }
        item.status="sending";item.lastAttemptAt=new Date().toISOString();persistOutbox();
        let result;
        try{
          const request=item.client==="api"?auth.api:auth.aiApi;
          result=await request(item.route,{method:"POST",body:JSON.stringify(item.payload)});
        }catch(error){
          item.attempts=Math.max(0,Number(item.attempts||0))+1;
          const message=error&&error.message?error.message:"Неизвестная ошибка отправки";
          const networkFailure=error instanceof TypeError||/failed to fetch|networkerror|load failed/i.test(message);
          if(networkFailure&&item.attempts<2){
            item.status="queued";item.error="Временная ошибка соединения. Повторная попытка…";
            persistOutbox();
            await new Promise(resolve=>setTimeout(resolve,1200));
            continue;
          }
          item.status="failed";
          item.error=networkFailure
            ?"Не удалось подключиться к серверу ИИ (сеть или CORS). Запрос сохранён на устройстве."
            :message;
          item.failedAt=new Date().toISOString();persistOutbox();
          toast("Запрос сохранён локально. "+item.error);break;
        }
        outbox=outbox.filter(entry=>entry.id!==item.id);
        try{persistOutbox();}catch(storageError){console.warn("Could not remove completed outbox task:",storageError);}
        await refreshGame();
        const callback=outboxCallbacks.get(item.id);
        outboxCallbacks.delete(item.id);
        if(callback){
          try{toast(typeof callback==="function"?callback(result):callback);}
          catch(error){console.warn("Background success message failed:",error);}
        }else await handleBackgroundSuccess(item,result);
      }
    }finally{outboxRunning=false;updateOutboxIndicator();}
  }
  function retryFailedBackgroundJobs(){
    if(outboxRunning)return;
    outbox.forEach(item=>{if(item.status==="failed"){item.status="queued";item.attempts=0;delete item.error;}});
    try{persistOutbox();void startBackgroundQueue();}catch(error){toast(error.message);}
  }
  function discardBlockedBackgroundJobs(){
    if(outboxRunning)return;
    const count=outbox.filter(item=>item.status==="blocked"||item.status==="failed").length;
    if(!count)return;
    if(!confirm("Удалить "+count+" сохранённых запрос(ов) с ошибкой? Это удалит только локальные копии. Уже принятый сервером запрос отменить таким способом нельзя."))return;
    outbox=outbox.filter(item=>item.status!=="blocked"&&item.status!=="failed");
    try{persistOutbox();toast("Локальные копии запросов удалены.");}catch(error){toast(error.message);}
  }
  function attachStaticLocalDrafts(){
    ["order","amendmentText","amendmentReason","referendumQuestion"].forEach(id=>bindLocalDraft($(id),id));
  }

  let electionTab = "position";
  
  let worldMapPromise = null, toastTimer = null, needsSetupAfterBusy = false;

  function toast(message) {
    const root=$("toast"); if(!root)return;
    root.textContent=message; root.classList.remove("hidden");
    clearTimeout(toastTimer); toastTimer=setTimeout(()=>root.classList.add("hidden"),4500);
  }
  function actionErrorMessage(error){
    const code=error&&typeof error.message==="string"?error.message:"";
    const known={
      insufficient_treasury:"В казне недостаточно средств для этого действия. Проверьте доступный бюджет.",
      insufficient_campaign_funds:"Недостаточно средств на проведение этой кампании.",
      no_action_points:"На этот месяц закончились очки действий. Продолжить можно после следующего месяца."
    };
    return known[code]||code||"ошибка сервера";
  }
  function node(tag,cls,content){
    const el=document.createElement(tag);if(cls)el.className=cls;
    if(content!==undefined&&content!==null)el.textContent=String(content);
    return el;
  }
  function setText(id,value){const el=$(id);if(el)el.textContent=value===undefined||value===null?"—":String(value);}
  function number(value,digits=1){return Number(value||0).toLocaleString("ru-RU",{maximumFractionDigits:digits});}
  function money(value){
    const n=Number(value||0);
    return Math.abs(n)>=1000?number(n/1000,2)+" трлн $":number(n,2)+" млрд $";
  }
  function signedMoney(value){const n=Number(value||0);return(n>0?"+":n<0?"−":"")+money(Math.abs(n));}
  function clamp(value,min=0,max=100){return Math.max(min,Math.min(max,Number(value||0)));}
  function dateLabel(value){
    if(!value)return "—";
    const raw=String(value).slice(0,10),date=new Date(raw+"T12:00:00Z");
    return Number.isNaN(date.getTime())?raw:new Intl.DateTimeFormat("ru-RU",{day:"numeric",month:"long",year:"numeric",timeZone:"UTC"}).format(date);
  }
  function flagNode(iso2, fallback){
    if(iso2 && /^[A-Z]{2}$/.test(String(iso2))){
      return sprite("flags.svg","flag-"+iso2,"flag-svg");
    }
    return node("span","flag-fallback",fallback||"🏳️");
  }
  function sprite(file,symbol,className){
    const image=document.createElement("img");
    image.className=className||"";image.alt="";image.decoding="async";image.loading="lazy";
    if(file==="flags.svg") image.src="./assets/flags/"+String(symbol).replace(/^flag-/,"")+".svg";
    else image.src="./assets/portraits/"+String(symbol).replace(/^p/,"")+".svg";
    image.onerror=()=>{image.style.display="none";};
    return image;
  }
  function portraitIdFromName(name){
    let hash=0;for(const ch of String(name||""))hash=((hash*31)+ch.charCodeAt(0))>>>0;
    return "p"+String((hash%16)+1).padStart(2,"0");
  }
  function portraitNode(id,cls){
    return sprite("portraits.svg",/^p(0[1-9]|1[0-6])$/.test(String(id||""))?id:"p01",cls||"portrait-svg");
  }
  function setBar(id,value){const el=$(id);if(el)el.style.width=clamp(value)+"%";}

  function renderMetrics(game){
    const s=game.state||{};
    setText("gdp",money(s.gdp));
    setText("gdpGrowth","Темп роста: "+(Number(s.gdpGrowth)>0?"+":"")+number(s.gdpGrowth,2)+"%");
    setText("treasury",money(s.treasury));
    setText("budget","Бюджетный баланс: "+signedMoney(s.budgetBalance));
    setText("inflation",number(s.inflation,2)+"%");
    setText("unemployment",number(s.unemployment,2)+"%");
    setText("approval",Math.round(Number(s.approval||0))+"%");
    setText("stability",Math.round(Number(s.stability||0))+"/100");
    setBar("approvalBar",s.approval);setBar("stabilityBar",s.stability);
    setText("population",number(s.population,1)+" млн");
    setText("militaryPower",Math.round(Number(s.militaryPower||0))+" / 100");
    setText("debt",number(s.debt,1)+"% ВВП");
    const services=s.publicServices??58,education=s.education??55,health=s.healthcare??58,infrastructure=s.infrastructure??52;
    const development=Math.round((clamp(services)+clamp(education)+clamp(health)+clamp(infrastructure)+clamp(s.stability)+clamp(s.approval))/6);
    setText("developmentScore",development);
    setText("servicesValue",Math.round(clamp(services))+"/100");
    setText("educationValue",Math.round(clamp(education))+"/100");
    setText("healthValue",Math.round(clamp(health))+"/100");
    setText("infrastructureValue",Math.round(clamp(infrastructure))+"/100");
    setBar("servicesBar",services);setBar("educationBar",education);setBar("healthBar",health);setBar("infrastructureBar",infrastructure);
    const points=Math.max(0,Number(s.actionPoints??2));
    setText("actionPoints",points+" / 2");setText("actionPointsLarge",points);
  }

  function loadWorldGeoJSON(){
    if(!worldMapPromise)worldMapPromise=fetch("./assets/world-countries.geojson",{cache:"force-cache"})
      .then(r=>{if(!r.ok)throw new Error("локальные данные карты: HTTP "+r.status);return r.json();})
      .then(data=>{if(!data||!Array.isArray(data.features)||!data.features.length)throw new Error("файл геоданных повреждён");return data;});
    return worldMapPromise;
  }
  function mollweidePoint(point,width,height){
    const lon=Number(point[0])*Math.PI/180,lat=Math.max(-89.9999,Math.min(89.9999,Number(point[1])))*Math.PI/180;
    let theta=lat;
    for(let i=0;i<12;i++){const den=2+2*Math.cos(2*theta);if(Math.abs(den)<1e-9)break;const delta=(2*theta+Math.sin(2*theta)-Math.PI*Math.sin(lat))/den;theta-=delta;if(Math.abs(delta)<1e-8)break;}
    return [width/2+(2*Math.SQRT2/Math.PI*lon*Math.cos(theta))*width/(4*Math.SQRT2),height/2-(Math.SQRT2*Math.sin(theta))*height/(2*Math.SQRT2)];
  }
  function mapRingPath(ring,width,height){
    if(!Array.isArray(ring)||ring.length<3)return "";
    let d="",prev=null,segments=0;
    for(const point of ring){if(!Array.isArray(point)||point.length<2)continue;const lon=Number(point[0]),p=mollweidePoint(point,width,height),seam=prev&&Math.abs(lon-prev[0])>180;d+=(prev&&!seam?"L":"M")+p[0].toFixed(2)+","+p[1].toFixed(2);if(!prev||seam)segments++;prev=[lon,Number(point[1])];}
    return segments===1?d+"Z":d;
  }
  function geometryPath(g,w,h){
    if(!g)return "";const polygons=g.type==="Polygon"?[g.coordinates]:g.type==="MultiPolygon"?g.coordinates:[];let d="";
    for(const polygon of polygons||[])for(const ring of polygon||[])d+=mapRingPath(ring,w,h);
    return d;
  }
  async function renderWorldMap(iso2){
    const root=$("worldMap");if(!root)return;root.replaceChildren(node("div","map-loading","Загружаем встроенную карту мира…"));
    try{
      const data=await loadWorldGeoJSON(),w=900,h=450,ns="http://www.w3.org/2000/svg",svg=document.createElementNS(ns,"svg");
      svg.setAttribute("class","world-map-svg");svg.setAttribute("viewBox","0 0 "+w+" "+h);svg.setAttribute("role","img");svg.setAttribute("aria-label","Политическая карта мира");svg.setAttribute("preserveAspectRatio","xMidYMid meet");
      const ocean=document.createElementNS(ns,"rect");ocean.setAttribute("class","map-ocean");ocean.setAttribute("width",w);ocean.setAttribute("height",h);svg.append(ocean);
      const grid=document.createElementNS(ns,"g");grid.setAttribute("class","map-graticule");
      for(const lat of [-60,-30,0,30,60]){const line=document.createElementNS(ns,"path");let d="";for(let lon=-180;lon<=180;lon+=4){const p=mollweidePoint([lon,lat],w,h);d+=(lon===-180?"M":"L")+p[0].toFixed(1)+","+p[1].toFixed(1);}line.setAttribute("d",d);grid.append(line);}svg.append(grid);
      const countries=document.createElementNS(ns,"g");
      data.features.forEach(feature=>{const props=feature.properties||{},eh=String(props.ISO_A2_EH||"").toUpperCase(),code=(eh&&eh!=="-99"?eh:String(props.ISO_A2||"")).toUpperCase(),path=document.createElementNS(ns,"path");
        path.setAttribute("d",geometryPath(feature.geometry,w,h));path.setAttribute("class","map-country"+(code===String(iso2||"").toUpperCase()?" active":""));path.setAttribute("data-iso2",code);
        const name=props.NAME_RU||props.NAME_EN||props.ADMIN||props.NAME||"Государство";path.setAttribute("aria-label",name);const title=document.createElementNS(ns,"title");title.textContent=name;path.append(title);countries.append(path);});
      svg.append(countries);root.replaceChildren(svg);
    }catch(error){root.replaceChildren(node("div","map-loading","Не удалось открыть встроенную карту: "+(error&&error.message?error.message:"ошибка данных")));}
  }

  function renderIdentity(game){
    const name=game.name_local||game.name_en||game.save_name||"Государство";
    const flag=game.flag_emoji||"🏳️";
    const region=[game.region,game.government_type].filter(Boolean).join(" · ").toUpperCase() + ((game.state||{}).dictatorship ? " · АВТОРИТАРНЫЙ РЕЖИМ" : "");
    setText("country",name);setText("region",region||"ГОСУДАРСТВО");
    const flagRoot=$("flag");if(flagRoot)flagRoot.replaceChildren(flagNode(game.iso2,flag));
    const sideFlag=$("sidebarFlag");if(sideFlag)sideFlag.replaceChildren(flagNode(game.iso2,flag));
    setText("bio",game.president_name+", "+game.president_age+" лет · "+(game.president_bio||"Президент"));
    const portraitRoot=$("presidentPortrait");
    if(portraitRoot)portraitRoot.replaceChildren(portraitNode((game.state||{}).presidentPortrait||portraitIdFromName(game.president_name)));
    setText("date",dateLabel(game.game_date));setText("term","Месяц "+String(game.turn_number||1).padStart(3,"0"));
    setText("topbarTurn","Ход "+String(game.turn_number||1).padStart(3,"0"));
    setText("sidebarTurn","Месяц "+String(game.turn_number||1).padStart(3,"0"));
    setText("sidebarDate",dateLabel(game.game_date));setText("sidebarCountry",name);
    setText("sidebarRegion",region||"Государство");
    renderWorldMap(game.iso2);
  }

  const MINISTER_SKILLS=[
    ["finance","Финансы"],["foreignAffairs","Дипломатия"],["defense","Оборона"],
    ["economy","Экономика"],["healthcare","Здравоохранение"],["education","Образование"],
    ["internalAffairs","Внутренние дела"]
  ];
  const MINISTER_PORTFOLIO_SKILLS={
    "Финансы":"finance","Иностранные дела":"foreignAffairs","Оборона":"defense",
    "Экономика":"economy","Здравоохранение":"healthcare","Образование":"education","Внутренние дела":"internalAffairs"
  };
  function ministerSkillBars(skills,compact=false){
    const root=node("div",compact?"minister-skill-grid compact":"minister-skill-grid");
    MINISTER_SKILLS.forEach(([key,label])=>{
      const value=clamp(Number(skills&&skills[key]||0),0,100);
      const item=node("div","minister-skill-item"),head=node("div","minister-skill-head");
      head.append(node("span","",label),node("b","",Math.round(value)+"/100"));
      const track=node("div","minister-skill-track"),fill=node("i");
      fill.style.width=value+"%";track.append(fill);item.append(head,track);root.append(item);
    });
    return root;
  }
  function renderMinisters(items){
    const all=Array.isArray(items)?items:[];
    const appointed=all.filter(item=>!item.is_candidate);
    const candidates=all.filter(item=>item.is_candidate);
    const root=$("ministers");
    if(root){
      root.replaceChildren();
      if(!appointed.length)root.append(node("div","loading-row","Кабинет пока не сформирован. Выберите министров из кадрового резерва."));
      appointed.forEach(minister=>{
        const row=node("article","minister-row minister-appointed-row"),traits=minister.traits&&typeof minister.traits==="object"?minister.traits:{};
        const avatar=node("div","minister-avatar");avatar.append(portraitNode(traits.portraitId||portraitIdFromName(minister.full_name),"portrait-svg"));
        const info=node("div","minister-info"),skillKey=MINISTER_PORTFOLIO_SKILLS[minister.portfolio],skill=Number(traits.skills&&traits.skills[skillKey]||minister.competence||50);
        info.append(node("b","",minister.full_name));
        info.append(node("small","",minister.portfolio+" · "+minister.age+" лет"));
        info.append(node("small","minister-reliability","Навык по мандату "+skill+"/100 · Компетентность "+Number(minister.competence||0)+"/100 · Лояльность "+Number(minister.loyalty||0)+"/100"));
        const score=node("div","minister-score","★ "+skill);
        const dismiss=node("button","dismiss-button","×");dismiss.type="button";dismiss.title="Отправить министра в отставку";
        dismiss.dataset.dismissMinister=minister.id;dismiss.dataset.ministerName=minister.full_name;dismiss.disabled=busy;
        row.append(avatar,info,score,dismiss);root.append(row);
      });
    }
    const reserve=$("ministerCandidates");
    if(reserve){
      reserve.replaceChildren();
      if(!candidates.length)reserve.append(node("div","loading-row","Свободных кандидатов нет."));
      candidates.forEach(candidate=>{
        const card=node("article","minister-candidate-card"),traits=candidate.traits&&typeof candidate.traits==="object"?candidate.traits:{};
        const top=node("div","minister-candidate-top"),avatar=node("div","minister-avatar");
        avatar.append(portraitNode(traits.portraitId||portraitIdFromName(candidate.full_name),"portrait-svg"));
        const identity=node("div","minister-candidate-identity");
        identity.append(node("b","",candidate.full_name),node("small","",candidate.age+" лет · "+(traits.archetypeLabel||"Политический кандидат")));
        top.append(avatar,identity);
        const metrics=node("div","minister-candidate-metrics");
        metrics.append(node("span","","Компетентность "+Number(candidate.competence||0)+"/100"),node("span","","Лояльность "+Number(candidate.loyalty||0)+"/100"));
        const strengths=Array.isArray(traits.specializations)?traits.specializations:[];
        if(strengths.length)card.append(top,node("div","minister-candidate-strengths","Сильные стороны: "+strengths.map(key=>MINISTER_SKILLS.find(item=>item[0]===key)?.[1]||key).join(" · ")),metrics);
        else card.append(top,metrics);
        card.append(ministerSkillBars(traits.skills,true));
        const select=node("button","minister-select-button","Изучить кандидата и выбрать мандат →");
        select.type="button";select.dataset.selectMinisterCandidate=candidate.id;select.disabled=busy;card.append(select);
        reserve.append(card);
      });
    }
    const select=$("ministerPortfolio");
    if(select){
      const occupied=new Set(appointed.map(item=>item.portfolio));
      Array.from(select.options).forEach(option=>option.disabled=occupied.has(option.value));
      const free=Array.from(select.options).find(option=>!option.disabled);
      if(free)select.value=free.value;
    }
  }
  function openMinisterAssignment(candidate){
    if(!candidate)return;
    selectedMinisterCandidate=candidate;
    $("ministerCandidateId").value=candidate.id;
    const root=$("ministerCandidateSummary"),traits=candidate.traits&&typeof candidate.traits==="object"?candidate.traits:{};
    root.replaceChildren();
    const top=node("div","minister-selected-top"),avatar=node("div","minister-avatar");
    avatar.append(portraitNode(traits.portraitId||portraitIdFromName(candidate.full_name),"portrait-svg"));
    const info=node("div","");info.append(node("b","",candidate.full_name),node("small","",candidate.age+" лет · "+(traits.archetypeLabel||"Кандидат")));
    top.append(avatar,info);root.append(top);
    root.append(node("p","minister-selected-rating","Компетентность "+candidate.competence+"/100 · Лояльность "+candidate.loyalty+"/100"));
    root.append(ministerSkillBars(traits.skills,false));
    const free=Array.from($("ministerPortfolio").options).find(option=>!option.disabled);
    if(free)$("ministerPortfolio").value=free.value;
    $("ministerDialog").showModal();
  }

  function renderEvents(items){
    const root=$("newsList");if(!root)return;root.replaceChildren();
    if(!items||!items.length){root.append(node("div","loading-row","События появятся после начала кампании."));return;}
    items.forEach(event=>{
      const row=node("article","event-row"),head=node("div","event-row-head");
      head.append(node("span","event-type",String(event.event_type||"СОБЫТИЕ").replaceAll("_"," ").toUpperCase()));
      head.append(node("time","",dateLabel(event.game_date)));
      row.append(head,node("b","",event.headline),node("p","",event.article));root.append(row);
    });
  }

  function relationLabel(score,status){
    const n=Number(score||0);
    if(status==="allied"||n>=55)return "Союзные отношения";
    if(status==="friendly"||n>=20)return "Партнёрские отношения";
    if(status==="hostile"||n<=-45)return "Кризис отношений";
    if(status==="strained"||n<=-20)return "Напряжённые отношения";
    return "Нейтральные отношения";
  }
  function renderRelations(items){
    const root=$("relationsList");if(!root)return;root.replaceChildren();
    setText("relationCount",String((items||[]).length));
    if(!items||!items.length){root.append(node("div","loading-row","Дипломатические контакты пока не установлены."));return;}
    items.forEach(relation=>{
      const row=node("div","relation-row"),flag=node("div","relation-flag");
      if(relation.iso2)flag.append(flagNode(relation.iso2,relation.flag_emoji));else flag.textContent="🌐";
      const info=node("div","relation-info");
      const raw=relation.treaties&&typeof relation.treaties==="object"?relation.treaties:[];
      const pack=Array.isArray(raw)?{talks:null,proposal:null,activeDeals:raw}:raw;
      const deals=Array.isArray(pack.activeDeals)?pack.activeDeals:[];
      info.append(node("b","",relation.other_country_name),
        node("small","",relationLabel(relation.relation_score,relation.status)+" · "+(deals.length?deals.length+" соглаш.":"нет соглашений")));
      if(pack.talks&&pack.talks.status==="open")info.append(node("small","diplomacy-stage","Идут дипломатические консультации"));
      const score=node("div","relation-score",(Number(relation.relation_score)>0?"+":"")+relation.relation_score);
      score.style.color=Number(relation.relation_score)>=0?"#328b77":"#ba6561";
      const actions=node("div","relation-actions");
      const button=node("button","primary-button","Открыть переговоры →");
      button.type="button";button.dataset.aiDiplomacy=relation.id;
      button.dataset.country=relation.other_country_name;button.disabled=busy;actions.append(button);
      row.append(flag,info,score,actions);root.append(row);
    });
  }

  function renderUnits(items){
    const root=$("militaryUnits");if(!root)return;root.replaceChildren();
    if(!items||!items.length){root.append(node("div","loading-row","Военные подразделения не созданы."));return;}
    items.forEach(unit=>{
      const row=node("div","unit-row"),icon=node("div","unit-icon","⬡"),info=node("div","unit-info"),stat=node("div","unit-stat");
      info.append(node("b","",unit.unit_type),node("small","",number(unit.quantity,0)+" единиц · снабжение "+unit.supply+"/100"));
      stat.append(node("b","","Готовность "+unit.readiness+"%"));
      const track=node("div","unit-track"),fill=node("i");fill.style.width=clamp(unit.readiness)+"%";track.append(fill);stat.append(track);
      row.append(icon,info,stat);root.append(row);
    });
  }
  const MILITARY_TECH_LABELS={
    reconnaissance:"Разведка и наблюдение",communications:"Связь и командование",logistics:"Военная логистика",
    air_defense:"Противовоздушная оборона",armor:"Бронетехника",precision:"Точность вооружений",
    military_medicine:"Военная медицина",naval:"Морские системы",cyber_defense:"Киберзащита"
  };
  const MILITARY_TECH_HINTS={
    reconnaissance:"Обнаружение угроз и качество разведданных",
    communications:"Согласованность штаба и скорость выполнения приказов",
    logistics:"Снабжение, ремонт и устойчивость подразделений",
    air_defense:"Защита войск и государственных объектов",
    armor:"Защищённость и мобильность сухопутных частей",
    precision:"Эффективность операций и снижение потерь",
    military_medicine:"Восстановление и снижение безвозвратных потерь",
    naval:"Готовность флота и морские коммуникации",
    cyber_defense:"Устойчивость военных сетей и инфраструктуры"
  };
  function renderMilitary(payload){
    const military=payload.military||((payload.game&&payload.game.state)||{}).military||{};
    const manpower=military.manpower||{},contracts=military.contracts||{},budget=military.budget||{},research=military.research||{};
    setText("militaryActivePersonnel",number(manpower.activePersonnel||0,0));
    setText("militaryReservePersonnel",number(manpower.trainedReserve||0,0));
    setText("militaryAvailablePersonnel",number(manpower.availablePool||0,0));
    setText("militaryApplicants",number(contracts.monthlyApplicants||0,0));
    const law=$("militaryServiceLaw");if(law)law.value=(military.laws&&military.laws.service)||"volunteer";
    const salary=$("militaryContractSalary");if(salary){salary.value=String(Number(contracts.salaryIndex||1));setText("militarySalaryValue",Number(contracts.salaryIndex||1).toFixed(2).replace(".",",")+"×");}
    const budgetControl=$("militaryBudgetShare");if(budgetControl){budgetControl.value=String(Number(budget.shareOfGdp||1.6));setText("militaryBudgetValue",Number(budget.shareOfGdp||1.6).toFixed(1).replace(".",",")+"%");}
    const researchControl=$("militaryResearchShare");if(researchControl){researchControl.value=String(Math.round(Number(budget.researchShare||0.12)*100));setText("militaryResearchShareValue",Math.round(Number(budget.researchShare||0.12)*100)+"%");}
    const technologies=Array.isArray(payload.technologies)?payload.technologies:[];
    const researchSelect=$("militaryResearchSelect");
    if(researchSelect){
      const previous=research.selectedTech||"logistics";
      researchSelect.replaceChildren();
      technologies.forEach(tech=>{
        const option=document.createElement("option");option.value=tech.tech_id;
        option.textContent=(MILITARY_TECH_LABELS[tech.tech_id]||tech.tech_id)+" · уровень "+Number(tech.level||0);
        researchSelect.append(option);
      });
      if(technologies.some(tech=>tech.tech_id===previous))researchSelect.value=previous;
    }
    const technologyRoot=$("militaryTechnologyList");
    if(technologyRoot){
      technologyRoot.replaceChildren();
      if(!technologies.length)technologyRoot.append(node("div","loading-row","Технологические направления не найдены."));
      technologies.forEach(tech=>{
        const level=Number(tech.level||0),points=Number(tech.research_points||0),target=(level+1)*100;
        const progress=level>=5?100:Math.min(100,points/Math.max(1,target)*100);
        const card=node("article","military-technology-card"),head=node("div","military-technology-head");
        head.append(node("span","",MILITARY_TECH_LABELS[tech.tech_id]||tech.tech_id),node("small","",level>=5?"МАКС. УРОВЕНЬ":"Уровень "+level));
        const detail=node("p","",MILITARY_TECH_HINTS[tech.tech_id]||"Военно-техническое развитие страны");
        const track=node("div","military-tech-track"),fill=node("i");fill.style.width=progress+"%";track.append(fill);
        card.append(head,detail,track);
        if(tech.is_researching)card.append(node("small","minister-reliability","Текущий приоритет · "+points+" / "+target+" очков"));
        technologyRoot.append(card);
      });
    }
    const programsRoot=$("activeMilitaryPrograms");
    if(programsRoot){
      programsRoot.replaceChildren();
      const programs=Array.isArray(military.programs)?military.programs:[];
      const active=programs.filter(program=>program.status==="active");
      if(!active.length)programsRoot.append(node("small","military-explainer","Активных военных программ нет."));
      active.forEach(program=>{
        const row=node("div","active-military-program");
        row.append(node("span","",program.title+" · "+program.monthsCompleted+"/"+program.durationMonths+" мес."));
        const cancel=node("button","secondary-button","Остановить");cancel.type="button";cancel.dataset.cancelMilitaryProgram=program.programId;cancel.disabled=busy;row.append(cancel);
        programsRoot.append(row);
      });
    }
    const unitRoot=$("militaryMapUnit");
    if(unitRoot){
      const previous=unitRoot.value;unitRoot.replaceChildren();
      (payload.units||[]).forEach(unit=>{
        const option=document.createElement("option");option.value=unit.id;option.textContent=unit.unit_type;unitRoot.append(option);
      });
      if((payload.units||[]).some(unit=>unit.id===previous))unitRoot.value=previous;
    }
    const relations=Array.isArray(payload.relations)?payload.relations:[];
    const wars=Array.isArray(payload.wars)?payload.wars:[];
    const activeWar=wars.find(war=>war.status==="active")||null;
    const opponentSelect=$("warOpponentSelect");
    if(opponentSelect){
      const previous=opponentSelect.value;opponentSelect.replaceChildren();
      relations.forEach(relation=>{
        const option=document.createElement("option");option.value=relation.other_country_id;
        option.textContent=relation.other_country_name;opponentSelect.append(option);
      });
      if(relations.some(relation=>String(relation.other_country_id)===previous))opponentSelect.value=previous;
      opponentSelect.disabled=Boolean(activeWar);
    }
    const noWar=$("militaryNoWar"),warPanel=$("militaryActiveWar");
    if(noWar)noWar.classList.toggle("hidden",Boolean(activeWar));
    if(warPanel)warPanel.classList.toggle("hidden",!activeWar);
    const status=$("militaryWarStatus");
    if(status){status.textContent=activeWar?"ВОЙНА":"МИР";status.classList.toggle("war",Boolean(activeWar));}
    if(activeWar){
      const front=activeWar.front_state||{},control=Number(front.territoryControl??50);
      setText("militaryOpponentName",activeWar.opponent_country_name);
      setText("militaryFrontValue",control.toFixed(1)+"%");
      const fill=$("militaryFrontControl");if(fill)fill.style.width=clamp(control,0,100)+"%";
      setText("militaryFriendlyLosses",number(front.friendlyLosses||0,0));
      setText("militaryEnemyLosses",number(front.enemyLosses||0,0));
      setText("militaryBattleTurn",String(front.battleTurn||activeWar.turn_number||0));
      const mode=$("militaryCommandMode");if(mode)mode.value=activeWar.command_mode||"ai";
      const posture=$("militaryPosture");if(posture)posture.value=activeWar.strategic_posture||"balanced";
      const directive=$("militaryAiDirective");if(directive&&document.activeElement!==directive)directive.value=activeWar.commander_directive||"";
      const report=activeWar.last_report||{},domains=report.domainControl||front.domainControl||{};
      const lastAuto=report.autoTickAt?new Date(report.autoTickAt).toLocaleString("ru-RU",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):"ожидается первый цикл";
      setText("militaryWarReport",activeWar.command_mode==="ai"
        ?"АВТОНОМНЫЙ ШТАБ · последний цикл: "+lastAuto+". "+(report.aiReason||front.lastAiReason||"Штаб оценивает силы и снабжение.")+" Потери за цикл: "+number(report.friendlyLosses||0,0)+" / "+number(report.enemyLosses||0,0)+". Воздушный контроль: "+number(domains.air||50,1)+"%; морской: "+number(domains.sea||50,1)+"%."
        :"Ручное командование включено. Автоматические операции приостановлены; задавайте приказы на карте.");
      const advance=$("advanceMilitaryWar");if(advance){advance.textContent="Выполнить оперативный ход";advance.style.display=activeWar.command_mode==="ai"?"none":"";}
      const domainMetrics=$("militaryDomainMetrics");
      if(domainMetrics){
        const own=report.friendlyDomains||front.friendlyDomains||{},rival=report.enemyDomains||front.estimatedEnemyDomains||{};
        domainMetrics.replaceChildren();
        [["СУХОПУТНЫЕ",own.ground,rival.ground],["АВИАЦИЯ",own.air,rival.air],["ФЛОТ",own.naval,rival.naval]].forEach(([name,ours,theirs])=>{
          const item=node("div","military-domain-metric");
          item.append(node("small","",name),node("b","",number(ours||0,0)+" / "+number(theirs||0,0)));
          domainMetrics.append(item);
        });
      }
    }
    const patrolRoot=$("militaryPatrolList");
    if(patrolRoot){
      patrolRoot.replaceChildren();
      const patrols=Array.isArray(payload.patrols)?payload.patrols:[];
      if(!patrols.length)patrolRoot.append(node("div","loading-row","Патрульные маршруты ещё не созданы."));
      patrols.forEach(patrol=>{
        const row=node("div","military-patrol-row"),info=node("div","");
        info.append(node("b","",patrol.patrol_name),node("small","",(patrol.unit_type||"Подразделение")+" · "+(patrol.status==="active"?"Активен":"Приостановлен")+" · "+(Array.isArray(patrol.route)?patrol.route.length:0)+" точек"));
        row.append(info);
        if(patrol.status==="active"){const button=node("button","","Пауза");button.type="button";button.dataset.pausePatrol=patrol.id;button.disabled=busy;row.append(button);}
        patrolRoot.append(row);
      });
    }
    renderMilitaryMap(payload);
  }
  function inverseMollweidePoint(x,y,width,height){
    const theta=Math.asin(clamp(1-2*y/height,-1,1));
    const sinLatitude=clamp((2*theta+Math.sin(2*theta))/Math.PI,-1,1);
    const latitude=Math.asin(sinLatitude)*180/Math.PI;
    const cosine=Math.max(0.0001,Math.cos(theta));
    const longitude=(x-width/2)*2*Math.PI/(width*cosine)*180/Math.PI;
    return {lat:clamp(latitude,-90,90),lon:clamp(longitude,-180,180)};
  }
  function svgNode(tag,attrs){
    const element=document.createElementNS("http://www.w3.org/2000/svg",tag);
    Object.entries(attrs||{}).forEach(([key,value])=>element.setAttribute(key,String(value)));
    return element;
  }
  function mapFeatureCenter(feature,width,height){
    const props=feature&&feature.properties||{},lon=props.LABEL_X==null?NaN:Number(props.LABEL_X),lat=props.LABEL_Y==null?NaN:Number(props.LABEL_Y);
    if(Number.isFinite(lon)&&Number.isFinite(lat)&&lon>=-180&&lon<=180&&lat>=-90&&lat<=90){
      const p=mollweidePoint([lon,lat],width,height);return {x:p[0],y:p[1],lon,lat};
    }
    const geometry=feature&&feature.geometry;if(!geometry)return null;
    const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.type==="MultiPolygon"?geometry.coordinates:[];
    let sx=0,sy=0,n=0;
    polygons.forEach(poly=>(poly||[]).forEach((ring,index)=>{
      if(index!==0)return;
      for(const point of ring){if(!Array.isArray(point)||point.length<2)continue;const p=mollweidePoint(point,width,height);sx+=p[0];sy+=p[1];n++;}
    }));
    return n?{x:sx/n,y:sy/n}:null;
  }
  function sharedCountryBorder(a,b,width,height){
    const segments=feature=>{
      const geometry=feature&&feature.geometry;if(!geometry)return [];
      const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.type==="MultiPolygon"?geometry.coordinates:[];
      const out=[];
      for(const poly of polygons)for(const ring of (poly||[]).slice(0,1))for(let i=0;i<ring.length-1;i++){
        const p=ring[i],q=ring[i+1];const x=Number(p[0]).toFixed(3)+","+Number(p[1]).toFixed(3),y=Number(q[0]).toFixed(3)+","+Number(q[1]).toFixed(3);
        if(x!==y)out.push({key:x<y?x+"|"+y:y+"|"+x,p,q});
      }
      return out;
    };
    const own=new Map(segments(a).map(item=>[item.key,item])),shared=[];
    for(const item of segments(b)){const match=own.get(item.key);if(!match)continue;
      const p=mollweidePoint(match.p,width,height),q=mollweidePoint(match.q,width,height);
      const length=Math.hypot(q[0]-p[0],q[1]-p[1]);if(length>.25)shared.push({p,q,length,mid:[(p[0]+q[0])/2,(p[1]+q[1])/2]});
    }
    return shared;
  }
  function appendMilitaryModel(layer,x,y,branch,side,title,detail,dx=0,dy=0){
    const g=svgNode("g",{class:"military-model "+side+" branch-"+branch,transform:"translate("+(x+dx)+" "+(y+dy)+")"});
    const titleNode=svgNode("title",{});titleNode.textContent=title+(detail?" · "+detail:"");g.append(titleNode);
    g.append(svgNode("circle",{class:"military-model-shadow",cx:0,cy:2,r:15}),svgNode("circle",{class:"military-model-base",cx:0,cy:0,r:13}));
    const art=svgNode("g",{class:"military-model-art"});
    if(branch==="air"){
      art.append(svgNode("path",{d:"M0 -12 L2 -4 L10 1 L10 4 L2 2 L2 8 L5 11 L5 13 L0 12 L-5 13 L-5 11 L-2 8 L-2 2 L-10 4 L-10 1 L-2 -4 Z"}));
    }else if(branch==="naval"){
      art.append(svgNode("path",{d:"M-3 -11 L3 -11 L4 -4 L8 -2 L7 6 L3 10 L-3 10 L-7 6 L-8 -2 L-4 -4 Z"}),svgNode("path",{d:"M-3 -4 L3 -4 L3 3 L-3 3 Z"}),svgNode("path",{d:"M-10 12 Q-6 9 -2 12 T6 12 T12 12"}));
    }else if(branch==="hq"){
      art.append(svgNode("path",{d:"M-8 -8 L8 -8 L8 8 L-8 8 Z M-5 -5 L-1 -5 L-1 -1 L-5 -1 Z M1 -5 L5 -5 L5 -1 L1 -1 Z M-5 2 L5 2 L5 7 L-5 7 Z"}),svgNode("path",{d:"M0 -12 L0 -8 M0 -12 L7 -10 L0 -8 Z"}));
    }else{
      art.append(svgNode("circle",{cx:0,cy:-6,r:3.2}),svgNode("path",{d:"M-4 -2 Q0 -5 4 -2 L5 5 L2 6 L2 11 L-2 11 L-2 6 L-5 5 Z"}),svgNode("path",{d:"M-3 1 L-9 5 M3 1 L9 4 M-2 10 L-5 13 M2 10 L5 13 M-1 -9 L5 -11 L10 -7"}));
    }
    g.append(art);layer.append(g);
    const label=svgNode("text",{x:x+dx,y:y+dy+24,class:"military-model-label","text-anchor":"middle"});label.textContent=detail||title;layer.append(label);
    return g;
  }
  function applyMilitaryMapTransform(){
    if(militaryLeafletMap){setText("militaryZoomReset",militaryLeafletMap.getZoom()+"×");return;}
    if(!militaryMapLayer)return;
    militaryMapLayer.setAttribute("transform","translate("+militaryMapView.x+" "+militaryMapView.y+") translate(500 250) scale("+militaryMapView.scale+") translate(-500 -250)");
    setText("militaryZoomReset",Math.round(militaryMapView.scale*100)+"%");
  }
  function changeMilitaryMapZoom(factor){
    if(militaryLeafletMap){if(Number(factor)>=1)militaryLeafletMap.zoomIn();else militaryLeafletMap.zoomOut();return;}
    militaryMapView.scale=clamp(militaryMapView.scale*Number(factor||1),1,6);
    applyMilitaryMapTransform();
  }
  function renderMilitarySvgMap(payload){
    const root=$("militaryMap");if(!root)return;
    const saveKey=String(payload.game&&payload.game.id||"");
    if(militaryMapState.saveKey!==saveKey){
      militaryMapState={mode:"view",draft:[],justDragged:false,saveKey};
      militaryMapView={scale:1,x:0,y:0};
      const mode=$("militaryMapMode");if(mode)mode.value="view";
      setText("militaryMapDraftStatus","Обзор: подразделения показаны в местах базирования.");
    }
    root.replaceChildren(node("div","map-loading","Загружаем географическую карту…"));
    loadWorldGeoJSON().then(data=>{
      if(!root.isConnected)return;
      const width=1000,height=500;
      const svg=svgNode("svg",{viewBox:"0 0 "+width+" "+height,role:"application","aria-label":"Военная карта мира с географическими координатами и родами войск"});
      const defs=svgNode("defs",{});
      const water=svgNode("linearGradient",{id:"militaryWater",x1:"0",y1:"0",x2:"1",y2:"1"});
      water.append(svgNode("stop",{offset:"0%","stop-color":"#153a50"}),svgNode("stop",{offset:"100%","stop-color":"#071725"}));defs.append(water);
      const relief=svgNode("linearGradient",{id:"militaryRelief",x1:"0",y1:"0",x2:"0",y2:"1"});
      relief.append(svgNode("stop",{offset:"0%","stop-color":"#607b78"}),svgNode("stop",{offset:"100%","stop-color":"#344f56"}));defs.append(relief);
      svg.append(defs,svgNode("rect",{class:"military-ocean",width,height,fill:"url(#militaryWater)"}));
      const grid=svgNode("g",{class:"military-graticule"});
      for(const lon of [-150,-120,-90,-60,-30,0,30,60,90,120,150]){
        let d="";for(let lat=-84;lat<=84;lat+=3){const p=mollweidePoint([lon,lat],width,height);d+=(lat===-84?"M":"L")+p[0].toFixed(1)+","+p[1].toFixed(1);}
        grid.append(svgNode("path",{d}));
      }
      for(const lat of [-60,-30,0,30,60]){
        let d="";for(let lon=-180;lon<=180;lon+=3){const p=mollweidePoint([lon,lat],width,height);d+=(lon===-180?"M":"L")+p[0].toFixed(1)+","+p[1].toFixed(1);}
        grid.append(svgNode("path",{d}));
      }
      svg.append(grid);
      const layer=svgNode("g",{class:"military-map-layer"}),centers=new Map(),features=new Map();militaryMapLayer=layer;
      const war=(payload.wars||[]).find(item=>item.status==="active")||null;
      const homeIso=String(payload.game&&payload.game.iso2||"").toUpperCase();
      const enemyIso=String(war&&war.opponent_iso2||"").toUpperCase();
      data.features.forEach(feature=>{
        const props=feature.properties||{},eh=String(props.ISO_A2_EH||"").toUpperCase();
        const code=(eh&&eh!=="-99"?eh:String(props.ISO_A2||"")).toUpperCase();
        if(code)features.set(code,feature);
        const path=svgNode("path",{d:geometryPath(feature.geometry,width,height),class:"military-country"+(code===homeIso?" home":"")+(code===enemyIso?" enemy":"")});
        const tip=svgNode("title",{});tip.textContent=props.NAME_RU||props.NAME_EN||props.ADMIN||"Государство";path.append(tip);layer.append(path);
        const center=mapFeatureCenter(feature,width,height);if(center)centers.set(code,center);
      });
      function textLabel(x,y,value,cls){
        const t=svgNode("text",{x,y,class:cls||"map-label","text-anchor":"middle"});t.textContent=value;layer.append(t);return t;
      }
      const homeFeature=features.get(homeIso),enemyFeature=features.get(enemyIso);
      const home=centers.get(homeIso),enemy=centers.get(enemyIso);
      if(home)textLabel(home.x,home.y-20,payload.game.name_local||payload.game.name_en||"ВАШЕ ГОСУДАРСТВО","map-label map-label-home");
      if(war&&enemy)textLabel(enemy.x,enemy.y-20,war.opponent_country_name||"ПРОТИВНИК","map-label map-label-enemy");
      if(war){
        if(war.front_state&&war.front_state.theatreType==="land"&&homeFeature&&enemyFeature){
          const border=sharedCountryBorder(homeFeature,enemyFeature,width,height);
          if(border.length){
            const path=border.map(seg=>"M"+seg.p[0].toFixed(2)+","+seg.p[1].toFixed(2)+" L"+seg.q[0].toFixed(2)+","+seg.q[1].toFixed(2)).join(" ");
            layer.append(svgNode("path",{d:path,class:"military-land-front"}));
            border.sort((a,b)=>b.length-a.length);
            const sector=border[0];
            layer.append(svgNode("circle",{cx:sector.mid[0],cy:sector.mid[1],r:13,class:"military-front-sector"}));
            textLabel(sector.mid[0],sector.mid[1]+27,"СЕКТОР ФРОНТА","map-front-label");
          }else if(home&&enemy){
            textLabel((home.x+enemy.x)/2,(home.y+enemy.y)/2,"СУХОПУТНЫЙ ТЕАТР · ГРАНИЦА НЕ ВЫДЕЛЕНА","map-theatre-label");
          }
        }else if(homeFeature&&enemyFeature){
          const coast=feature=>{
            const p=feature&&feature.properties||{},center=[p.LABEL_X==null?NaN:Number(p.LABEL_X),p.LABEL_Y==null?NaN:Number(p.LABEL_Y)],g=feature.geometry;
            if(!g||!center.every(Number.isFinite))return null;
            const polys=g.type==="Polygon"?[g.coordinates]:g.type==="MultiPolygon"?g.coordinates:[];
            let best=null,score=Infinity;
            for(const poly of polys)for(const ring of (poly||[]).slice(0,1))for(const point of ring){
              let dx=Number(point[0])-center[0];if(dx>180)dx-=360;if(dx< -180)dx+=360;
              const d=dx*dx*Math.max(.15,Math.cos(center[1]*Math.PI/180))**2+(Number(point[1])-center[1])**2;
              if(d<score){score=d;best=point;}
            }
            return best?mollweidePoint(best,width,height):null;
          };
          const front=war.front_state||{};
          const c1=front.homeCoastAnchor?mollweidePoint([front.homeCoastAnchor.lon,front.homeCoastAnchor.lat],width,height):coast(homeFeature)||home&&[home.x,home.y];
          const c2=front.enemyCoastAnchor?mollweidePoint([front.enemyCoastAnchor.lon,front.enemyCoastAnchor.lat],width,height):coast(enemyFeature)||enemy&&[enemy.x,enemy.y];
          if(c1&&c2){
            const bend=(c1[0]+c2[0])/2,arcY=Math.min(c1[1],c2[1])-Math.min(95,Math.abs(c2[0]-c1[0])*.12);
            layer.append(svgNode("path",{d:"M"+c1[0]+","+c1[1]+" Q"+bend+","+arcY+" "+c2[0]+","+c2[1],class:"military-maritime-route"}));
            textLabel(bend,arcY-9,"МОРСКОЙ / ВОЗДУШНЫЙ ТВД","map-theatre-label");
          }
        }
      }
      const offsets={land:[-13,0],guard:[13,0],air:[0,-16],naval:[0,16]};
      const labels={land:"ПЕХОТА",guard:"ГВ",air:"АВИАЦИЯ",naval:"ФЛОТ"};
      const units=Array.isArray(payload.units)?payload.units:[];
      units.forEach(unit=>{
        const branch=String(unit.unit_branch||"land").toLowerCase();
        const hasCoordinates=unit.location_lat!=null&&unit.location_lon!=null;
        const lat=hasCoordinates?Number(unit.location_lat):NaN,lon=hasCoordinates?Number(unit.location_lon):NaN;
        const pos=Number.isFinite(lat)&&Number.isFinite(lon)?mollweidePoint([lon,lat],width,height):home&&[home.x,home.y];
        if(!pos)return;
        const offset=offsets[branch]||[0,0];
        const amount=branch==="air"?number(unit.quantity||0,0)+" борт.":branch==="naval"?number(unit.quantity||0,0)+" ед.":number(unit.active_personnel||0,0)+" чел.";
        appendMilitaryModel(layer,pos[0],pos[1],["land","guard","air","naval"].includes(branch)?branch:"land","friendly",unit.unit_type||"Воинская часть",(labels[branch]||"ЧАСТЬ")+" · "+amount,offset[0],offset[1]);
      });
      if(home&&!units.length)appendMilitaryModel(layer,home.x,home.y,"hq","friendly","Штаб вооружённых сил","ВАШ ШТАБ");
      if(war&&enemy)appendMilitaryModel(layer,enemy.x,enemy.y,"hq","enemy","Штаб противника","ОЦЕНКА · "+number(war.front_state&&war.front_state.enemyPersonnel||0,0)+" чел.");
      (payload.patrols||[]).filter(item=>item.status==="active").forEach(patrol=>{
        const route=Array.isArray(patrol.route)?patrol.route:[];if(route.length<2)return;
        const points=route.map(point=>mollweidePoint([Number(point.lon),Number(point.lat)],width,height));
        layer.append(svgNode("polyline",{points:points.map(p=>p[0]+","+p[1]).join(" "),class:"military-route-line"}));
        points.forEach(point=>layer.append(svgNode("circle",{cx:point[0],cy:point[1],r:3.5,class:"military-route-dot"})));
      });
      if(militaryMapState.draft.length){
        const points=militaryMapState.draft.map(point=>mollweidePoint([point.lon,point.lat],width,height));
        if(points.length>1)layer.append(svgNode("polyline",{points:points.map(p=>p[0]+","+p[1]).join(" "),class:"military-route-line"}));
        points.forEach(point=>layer.append(svgNode("circle",{cx:point[0],cy:point[1],r:4.5,class:"military-route-dot"})));
      }
      svg.append(layer);root.replaceChildren(svg);applyMilitaryMapTransform();
      svg.addEventListener("wheel",event=>{
        event.preventDefault();militaryMapView.scale=clamp(militaryMapView.scale*(event.deltaY<0?1.18:1/1.18),1,6);applyMilitaryMapTransform();
      },{passive:false});
      let drag=null;
      svg.addEventListener("pointerdown",event=>{
        if(event.button!==0)return;drag={x:event.clientX,y:event.clientY,baseX:militaryMapView.x,baseY:militaryMapView.y,moved:false};
        try{svg.setPointerCapture(event.pointerId);}catch(_){}
      });
      svg.addEventListener("pointermove",event=>{
        if(!drag)return;const rect=svg.getBoundingClientRect(),dx=(event.clientX-drag.x)*width/Math.max(1,rect.width),dy=(event.clientY-drag.y)*height/Math.max(1,rect.height);
        if(Math.abs(dx)+Math.abs(dy)>4)drag.moved=true;
        if(drag.moved){militaryMapView.x=drag.baseX+dx;militaryMapView.y=drag.baseY+dy;applyMilitaryMapTransform();}
      });
      svg.addEventListener("pointerup",()=>{
        if(drag&&drag.moved){militaryMapState.justDragged=true;setTimeout(()=>{militaryMapState.justDragged=false;},180);}drag=null;
      });
      svg.addEventListener("pointercancel",()=>{drag=null;});
      svg.addEventListener("click",event=>{
        if(militaryMapState.justDragged||militaryMapState.mode==="view")return;
        const point=svg.createSVGPoint();point.x=event.clientX;point.y=event.clientY;
        const local=point.matrixTransform(layer.getScreenCTM().inverse()),geo=inverseMollweidePoint(local.x,local.y,width,height);
        if(militaryMapState.mode==="patrol"){
          if(militaryMapState.draft.length>=8)return toast("В маршруте патруля уже восемь точек.");
          militaryMapState.draft.push(geo);setText("militaryMapDraftStatus","Точек маршрута: "+militaryMapState.draft.length+" · требуется минимум две.");
          const save=$("saveMilitaryPatrol");if(save)save.disabled=militaryMapState.draft.length<2;
          renderMilitaryMap(currentPayload||payload);return;
        }
        if(militaryMapState.mode==="order"){
          if(!war)return toast("Сначала начните военный конфликт.");
          const unitId=$("militaryMapUnit").value,orderType=$("militaryMapOrder").value;
          const objective=orderType==="advance"?"Достичь указанного района":orderType==="defend"?"Защитить указанный район":"Выполнить приказ в отмеченной точке";
          void runMilitaryAction({action:"issue_order",warId:war.id,unitId,orderType,targetLat:geo.lat,targetLon:geo.lon,objective},null,"Приказ передан подразделению.");
        }
      });
    }).catch(error=>root.replaceChildren(node("div","map-loading","Не удалось загрузить оперативную карту: "+(error.message||"ошибка данных"))));
  }

  function militaryCountryCode(feature){
    const p=feature&&feature.properties||{};
    const eh=String(p.ISO_A2_EH||"").toUpperCase();
    return (eh&&eh!=="-99"?eh:String(p.ISO_A2||"")).toUpperCase();
  }
  function militaryCountryLabel(feature){
    const p=feature&&feature.properties||{};
    return p.NAME_RU||p.NAME_EN||p.ADMIN||p.NAME||"Государство";
  }
  function leafletAnchor(anchor){
    if(!anchor||anchor.lat==null||anchor.lon==null)return null;
    const lat=Number(anchor.lat),lon=Number(anchor.lon);
    return Number.isFinite(lat)&&Number.isFinite(lon)?[lat,lon]:null;
  }
  function leafletCountryAnchor(feature){
    const p=feature&&feature.properties||{};
    if(p.LABEL_X==null||p.LABEL_Y==null)return null;
    const lon=Number(p.LABEL_X),lat=Number(p.LABEL_Y);
    return Number.isFinite(lon)&&Number.isFinite(lat)?[lat,lon]:null;
  }
  function militaryLeafletUnitIcon(branch,side,caption){
    const host=document.createElement("div");
    host.className="military-leaflet-unit "+(side==="enemy"?"enemy":"friendly")+" branch-"+branch;
    const art=document.createElement("div");art.className="military-leaflet-model";
    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("viewBox","0 0 64 64");svg.setAttribute("aria-hidden","true");
    const shapes={
      land:'<ellipse cx="32" cy="53" rx="19" ry="5" opacity=".24"/><circle cx="31" cy="15" r="6"/><path d="M23 25 Q31 20 39 25 L43 43 L36 45 L36 56 L27 56 L26 45 L19 43 Z"/><path d="M22 28 L12 39 L16 42 L26 34 M38 28 L48 33 L46 38 L37 36 M28 55 L21 62 M35 55 L42 62"/><path d="M39 25 L55 12 L58 15 L43 34" stroke-width="3"/>',
      guard:'<ellipse cx="32" cy="53" rx="19" ry="5" opacity=".24"/><path d="M20 22 L25 9 L39 9 L44 22 L39 25 L42 44 L36 46 L36 57 L27 57 L27 46 L21 44 L24 25 Z"/><circle cx="32" cy="17" r="6"/><path d="M22 30 L11 38 L16 42 L27 35 M40 30 L51 36 L47 41 L38 36 M28 56 L20 62 M36 56 L44 62"/>',
      air:'<path d="M32 3 L36 23 L58 36 L58 42 L36 36 L36 50 L44 57 L44 61 L32 58 L20 61 L20 57 L28 50 L28 36 L6 42 L6 36 L28 23 Z"/><path d="M32 9 L32 55" fill="none" stroke-width="2"/>',
      naval:'<path d="M27 4 L37 4 L39 17 L51 24 L47 46 L39 56 L25 56 L17 46 L13 24 L25 17 Z"/><path d="M24 24 L40 24 L40 37 L24 37 Z"/><path d="M32 11 L32 21 M18 43 Q26 38 32 43 T46 43 M12 54 Q22 49 32 54 T52 54" fill="none" stroke-width="2"/>',
      hq:'<path d="M10 20 L54 20 L54 54 L10 54 Z"/><path d="M16 27 L28 27 L28 39 L16 39 Z M36 27 L48 27 L48 39 L36 39 Z M26 42 L38 42 L38 54 L26 54 Z"/><path d="M32 3 L32 19 M32 3 L53 9 L32 15 Z"/>'
    };
    art.innerHTML="";
    const path=document.createElementNS("http://www.w3.org/2000/svg","g");
    path.innerHTML=shapes[branch]||shapes.land;
    svg.append(path);art.append(svg);host.append(art);
    if(caption){const label=document.createElement("span");label.textContent=caption;host.append(label);}
    return L.divIcon({html:host,className:"military-leaflet-icon",iconSize:[82,75],iconAnchor:[41,29],popupAnchor:[0,-26]});
  }
  function militaryLeafletPopup(title,detail,unit){
    const box=document.createElement("div"),heading=document.createElement("b"),body=document.createElement("div");
    heading.textContent=title||"Подразделение";body.textContent=detail||"";
    box.append(heading,body);
    if(unit){
      const stats=document.createElement("small");
      stats.textContent="Готовность "+number(unit.readiness||0,0)+"% · снабжение "+number(unit.supply||0,0)+"% · техника "+number(unit.equipment_level||0,0)+"%";
      box.append(stats);
    }
    return box;
  }
  function militarySharedBorders(a,b){
    const makeSegments=feature=>{
      const geometry=feature&&feature.geometry;if(!geometry)return [];
      const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.type==="MultiPolygon"?geometry.coordinates:[];
      const segments=[];
      for(const polygon of polygons)for(const ring of (polygon||[]).slice(0,1))for(let i=0;i<ring.length-1;i++){
        const p=ring[i],q=ring[i+1];
        if(!Array.isArray(p)||!Array.isArray(q)||p.length<2||q.length<2)continue;
        const kp=Number(p[0]).toFixed(3)+","+Number(p[1]).toFixed(3),kq=Number(q[0]).toFixed(3)+","+Number(q[1]).toFixed(3);
        if(kp===kq)continue;
        const dx=(Number(q[0])-Number(p[0]))*Math.cos((Number(p[1])+Number(q[1]))*.5*Math.PI/180),dy=Number(q[1])-Number(p[1]);
        segments.push({key:kp<kq?kp+"|"+kq:kq+"|"+kp,p,q,length:Math.hypot(dx,dy)});
      }
      return segments;
    };
    const own=new Map(makeSegments(a).map(segment=>[segment.key,segment])),shared=[];
    for(const segment of makeSegments(b)){
      const same=own.get(segment.key);if(!same)continue;
      shared.push({a:[Number(same.p[1]),Number(same.p[0])],b:[Number(same.q[1]),Number(same.q[0])],mid:[(Number(same.p[1])+Number(same.q[1]))/2,(Number(same.p[0])+Number(same.q[0]))/2],length:same.length});
    }
    return shared;
  }
  function militaryNearestBoundaryPoint(feature){
    const p=feature&&feature.properties||{},center=leafletCountryAnchor(feature),geometry=feature&&feature.geometry;
    if(!center||!geometry)return null;
    const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.type==="MultiPolygon"?geometry.coordinates:[];
    let best=null,score=Infinity;
    for(const polygon of polygons)for(const ring of (polygon||[]).slice(0,1))for(const point of ring){
      let dx=Number(point[0])-center[1];if(dx>180)dx-=360;if(dx< -180)dx+=360;
      const candidate=(dx*Math.cos(center[0]*Math.PI/180))**2+(Number(point[1])-center[0])**2;
      if(candidate<score){score=candidate;best=[Number(point[1]),Number(point[0])];}
    }
    return best;
  }
  function resetMilitaryMapView(){
    if(militaryLeafletMap){militaryLeafletMap.setView(militaryLeafletDefaultView.center,militaryLeafletDefaultView.zoom);return;}
    militaryMapView={scale:1,x:0,y:0};applyMilitaryMapTransform();
  }
  function renderMilitaryMap(payload){
    if(!window.L||!window.L.map||!window.L.tileLayer){renderMilitarySvgMap(payload);return;}
    const root=$("militaryMap");if(!root)return;
    const saveKey=String(payload.game&&payload.game.id||"");
    if(militaryMapState.saveKey!==saveKey){
      militaryMapState={mode:"view",draft:[],justDragged:false,saveKey};
      const mode=$("militaryMapMode");if(mode)mode.value="view";
      setText("militaryMapDraftStatus","Карта театра операций: выберите режим для прокладки маршрута или приказа.");
    }
    loadWorldGeoJSON().then(data=>{
      if(!root.isConnected)return;
      const activeWar=(payload.wars||[]).find(item=>item.status==="active")||null;
      const warId=activeWar?String(activeWar.id):"";
      const homeIso=String(payload.game&&payload.game.iso2||"").toUpperCase();
      const enemyIso=String(activeWar&&(activeWar.opponent_iso2||activeWar.front_state&&activeWar.front_state.enemyCountryIso2)||"").toUpperCase();
      const features=new Map();
      for(const feature of data.features||[]){const code=militaryCountryCode(feature);if(code)features.set(code,feature);}
      const homeFeature=features.get(homeIso),enemyFeature=features.get(enemyIso);
      const front=activeWar&&activeWar.front_state||{};
      const homeAnchor=leafletAnchor(front.homeAnchor)||leafletCountryAnchor(homeFeature);
      const enemyAnchor=leafletAnchor(front.enemyAnchor)||leafletCountryAnchor(enemyFeature);
      const homeCoast=leafletAnchor(front.homeCoastAnchor)||(homeFeature&&militaryNearestBoundaryPoint(homeFeature));
      const enemyCoast=leafletAnchor(front.enemyCoastAnchor)||(enemyFeature&&militaryNearestBoundaryPoint(enemyFeature));
      const frontAnchor=leafletAnchor(front.frontAnchor);
      let defaultCenter=homeAnchor||[20,0],defaultZoom=homeAnchor?4:2;
      if(activeWar&&front.theatreType==="land"&&(frontAnchor||homeAnchor&&enemyAnchor)){
        defaultCenter=frontAnchor||[(homeAnchor[0]+enemyAnchor[0])/2,(homeAnchor[1]+enemyAnchor[1])/2];defaultZoom=5;
      }else if(activeWar&&homeCoast&&enemyCoast){
        let lonDelta=enemyCoast[1]-homeCoast[1];if(lonDelta>180)lonDelta-=360;if(lonDelta< -180)lonDelta+=360;
        defaultCenter=[(homeCoast[0]+enemyCoast[0])/2,homeCoast[1]+lonDelta/2];defaultZoom=Math.abs(lonDelta)>80?2.4:4;
      }
      if(!militaryLeafletMap||militaryLeafletRoot!==root){
        if(militaryLeafletMap)militaryLeafletMap.remove();
        root.replaceChildren();
        militaryLeafletMap=L.map(root,{center:defaultCenter,zoom:defaultZoom,minZoom:2,maxZoom:18,zoomControl:false,worldCopyJump:true,preferCanvas:true});
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{
          minZoom:2,maxZoom:18,maxNativeZoom:19,updateWhenIdle:true,keepBuffer:2,
          attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
        }).addTo(militaryLeafletMap);
        militaryLeafletOverlay=L.layerGroup().addTo(militaryLeafletMap);
        militaryLeafletRoot=root;militaryLeafletSaveKey=saveKey;militaryLeafletWarKey=warId;
        militaryLeafletDefaultView={center:defaultCenter,zoom:defaultZoom};
        militaryLeafletMap.on("zoomend",()=>setText("militaryZoomReset",""+militaryLeafletMap.getZoom()+"×"));
        militaryLeafletMap.on("click",event=>{
          if(militaryMapState.mode==="view")return;
          const geo={lat:Number(event.latlng.lat.toFixed(5)),lon:Number(event.latlng.lng.toFixed(5))};
          if(militaryMapState.mode==="patrol"){
            if(militaryMapState.draft.length>=8)return toast("В маршруте патруля уже восемь точек.");
            militaryMapState.draft.push(geo);
            setText("militaryMapDraftStatus","Точек маршрута: "+militaryMapState.draft.length+" · требуется минимум две.");
            const save=$("saveMilitaryPatrol");if(save)save.disabled=militaryMapState.draft.length<2;
            renderMilitaryMap(currentPayload||payload);return;
          }
          if(militaryMapState.mode==="order"){
            const liveWar=(currentPayload&&Array.isArray(currentPayload.wars)?currentPayload.wars:payload.wars||[]).find(item=>item.status==="active");
            if(!liveWar)return toast("Сначала начните военный конфликт.");
            const unitId=$("militaryMapUnit")&&$("militaryMapUnit").value,orderType=$("militaryMapOrder")&&$("militaryMapOrder").value;
            const objective=orderType==="advance"?"Достичь указанного района":orderType==="defend"?"Защитить указанный район":"Выполнить приказ в отмеченной точке";
            void runMilitaryAction({action:"issue_order",warId:liveWar.id,unitId,orderType,targetLat:geo.lat,targetLon:geo.lon,objective},null,"Приказ передан подразделению.");
          }
        });
      }else if(militaryLeafletSaveKey!==saveKey||militaryLeafletWarKey!==warId){
        militaryLeafletSaveKey=saveKey;militaryLeafletWarKey=warId;
        militaryLeafletDefaultView={center:defaultCenter,zoom:defaultZoom};
        militaryLeafletMap.setView(defaultCenter,defaultZoom);
      }
      militaryLeafletOverlay.clearLayers();
      const addCountry=(feature,side)=>{
        if(!feature)return;
        const color=side==="home"?"#178b69":"#d24f45";
        L.geoJSON(feature,{style:{color,weight:2.2,opacity:.95,fillColor:color,fillOpacity:.16,interactive:false}}).addTo(militaryLeafletOverlay);
      };
      addCountry(homeFeature,"home");addCountry(enemyFeature,"enemy");
      if(homeAnchor){
        const homeName=militaryCountryLabel(homeFeature)||payload.game.name_local||payload.game.name_en||"ВАШЕ ГОСУДАРСТВО";
        const label=L.marker(homeAnchor,{interactive:false,icon:L.divIcon({className:"military-leaflet-country-label home",html:"<span></span>",iconSize:[150,20],iconAnchor:[75,22]})}).addTo(militaryLeafletOverlay);
        const el=label.getElement();if(el){const span=el.querySelector("span");if(span)span.textContent=homeName;}
      }
      if(activeWar&&enemyAnchor){
        const enemyName=activeWar.opponent_country_name||militaryCountryLabel(enemyFeature)||"ПРОТИВНИК";
        const label=L.marker(enemyAnchor,{interactive:false,icon:L.divIcon({className:"military-leaflet-country-label enemy",html:"<span></span>",iconSize:[150,20],iconAnchor:[75,22]})}).addTo(militaryLeafletOverlay);
        const el=label.getElement();if(el){const span=el.querySelector("span");if(span)span.textContent=enemyName;}
      }
      if(activeWar){
        if(front.theatreType==="land"&&homeFeature&&enemyFeature){
          const segments=militarySharedBorders(homeFeature,enemyFeature);
          if(segments.length){
            L.polyline(segments.map(seg=>[seg.a,seg.b]),{color:"#e34f48",weight:5,opacity:.9,lineCap:"round",lineJoin:"round"}).addTo(militaryLeafletOverlay);
            const best=segments.sort((a,b)=>b.length-a.length)[0];
            L.circleMarker(best.mid,{radius:9,color:"#641e24",weight:2,fillColor:"#ffb171",fillOpacity:1}).bindTooltip("Сектор сухопутного фронта").addTo(militaryLeafletOverlay);
          }else if(frontAnchor){
            L.circleMarker(frontAnchor,{radius:8,color:"#641e24",weight:2,fillColor:"#ffb171",fillOpacity:1}).bindTooltip("Оперативный сектор").addTo(militaryLeafletOverlay);
          }
        }else if(homeCoast&&enemyCoast){
          let lonDelta=enemyCoast[1]-homeCoast[1];if(lonDelta>180)lonDelta-=360;if(lonDelta< -180)lonDelta+=360;
          const endLon=homeCoast[1]+lonDelta,midLat=(homeCoast[0]+enemyCoast[0])/2-Math.min(16,Math.abs(lonDelta)*.08),midLon=homeCoast[1]+lonDelta/2;
          L.polyline([[homeCoast[0],homeCoast[1]],[midLat,midLon],[enemyCoast[0],endLon]],{color:"#2196c4",weight:3,dashArray:"9 8",opacity:.9}).bindTooltip("Морской / экспедиционный маршрут").addTo(militaryLeafletOverlay);
        }
      }
      const branchNames={land:"ПЕХОТА",guard:"ГВ",air:"АВИАЦИЯ",naval:"ФЛОТ"};
      const units=Array.isArray(payload.units)?payload.units:[];
      const positionGroups=new Map();
      units.forEach(unit=>{
        const lat=unit.location_lat==null?NaN:Number(unit.location_lat),lon=unit.location_lon==null?NaN:Number(unit.location_lon);
        if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
        const key=lat.toFixed(4)+","+lon.toFixed(4);
        if(!positionGroups.has(key))positionGroups.set(key,[]);
        positionGroups.get(key).push(unit);
      });
      units.forEach(unit=>{
        const branch=String(unit.unit_branch||"land").toLowerCase();
        const lat=unit.location_lat==null?NaN:Number(unit.location_lat),lon=unit.location_lon==null?NaN:Number(unit.location_lon);
        const position=Number.isFinite(lat)&&Number.isFinite(lon)?[lat,lon]:homeAnchor;
        if(!position)return;
        const group=positionGroups.get(Number.isFinite(lat)&&Number.isFinite(lon)?lat.toFixed(4)+","+lon.toFixed(4):"")||[unit];
        const index=group.indexOf(unit),angle=(Math.PI*2*index/Math.max(1,group.length))-(Math.PI/2);
        const radius=group.length>1?0.12+Math.floor(index/8)*0.05:0;
        const mapPosition=radius?[
          clamp(position[0]+Math.sin(angle)*radius,-85,85),
          position[1]+Math.cos(angle)*radius/Math.max(.25,Math.cos(position[0]*Math.PI/180))
        ]:position;
        if(mapPosition[1]>180)mapPosition[1]-=360;if(mapPosition[1]< -180)mapPosition[1]+=360;
        const amount=branch==="air"?number(unit.quantity||0,0)+" борт.":branch==="naval"?number(unit.quantity||0,0)+" ед.":number(unit.active_personnel||0,0)+" чел.";
        const caption=(branchNames[branch]||"ЧАСТЬ")+" · "+amount;
        L.marker(mapPosition,{icon:militaryLeafletUnitIcon(branch,"friendly",caption),keyboard:true,title:unit.unit_type||"Подразделение",alt:unit.unit_type||"Подразделение"})
          .bindPopup(militaryLeafletPopup(unit.unit_type,caption+" · готовность "+number(unit.readiness||0,0)+"% · снабжение "+number(unit.supply||0,0)+"%",unit))
          .addTo(militaryLeafletOverlay);
      });
      if(activeWar&&enemyAnchor){
        const estimate="Оценка: "+number(front.enemyPersonnel||0,0)+" военнослужащих";
        L.marker(enemyAnchor,{icon:militaryLeafletUnitIcon("hq","enemy","ШТАБ ПРОТИВНИКА"),title:"Штаб противника"})
          .bindPopup(militaryLeafletPopup(activeWar.opponent_country_name,estimate,null)).addTo(militaryLeafletOverlay);
      }
      (payload.patrols||[]).filter(item=>item.status==="active").forEach(patrol=>{
        const route=Array.isArray(patrol.route)?patrol.route:[];if(route.length<2)return;
        const points=route.map(p=>[Number(p.lat),Number(p.lon)]).filter(p=>p.every(Number.isFinite));
        L.polyline(points,{color:"#d2a443",weight:3,dashArray:"7 7"}).bindTooltip("Патрульный маршрут").addTo(militaryLeafletOverlay);
        points.forEach(p=>L.circleMarker(p,{radius:4,color:"#77571c",fillColor:"#f2c66c",fillOpacity:1}).addTo(militaryLeafletOverlay));
      });
      if(militaryMapState.draft.length){
        const points=militaryMapState.draft.map(p=>[p.lat,p.lon]);
        if(points.length>1)L.polyline(points,{color:"#e3a93c",weight:3,dashArray:"6 6"}).addTo(militaryLeafletOverlay);
        points.forEach(p=>L.circleMarker([p.lat,p.lon],{radius:5,color:"#6b4a14",fillColor:"#f4c35e",fillOpacity:1}).addTo(militaryLeafletOverlay));
      }
      if(militaryLeafletMap&&militaryLeafletRoot===root)window.setTimeout(()=>militaryLeafletMap&&militaryLeafletMap.invalidateSize({pan:false}),50);
    }).catch(error=>{
      if(!root.isConnected)return;
      if(window.L&&militaryLeafletMap){militaryLeafletMap.remove();militaryLeafletMap=null;militaryLeafletOverlay=null;militaryLeafletRoot=null;}
      root.classList.remove("leaflet-container");
      renderMilitarySvgMap(payload);
      console.warn("Leaflet military map failed; SVG map fallback is active:",error);
    });
  }

  function runMilitaryAction(payload,button,message){
    if(!currentGame||busy)return Promise.resolve();
    return withBusy(button,()=>api()("/api/presidential/game/military",{method:"POST",body:JSON.stringify(payload)}),message).catch(()=>{});
  }

  const DEFAULT_CONSTITUTION_ARTICLES=[
    {id:"executive",title:"Исполнительная власть",text:"Полномочия главы государства ограничены Конституцией, законом и механизмами парламентского и судебного контроля."},
    {id:"legislature",title:"Законодательная власть",text:"Законодательная власть осуществляется парламентом, избираемым на основе всеобщего и равного избирательного права."},
    {id:"judiciary",title:"Судебная власть",text:"Судебная власть независима. Судьи подчиняются Конституции и закону; вмешательство в правосудие запрещено."},
    {id:"elections",title:"Выборы и политическое представительство",text:"Выборы проводятся периодически на основе равного, прямого и тайного голосования при политическом плюрализме."},
    {id:"rights",title:"Права и свободы человека",text:"Государство признаёт и гарантирует основные права и свободы человека, равенство перед законом и судебную защиту."},
    {id:"regions",title:"Территориальное устройство",text:"Полномочия центральных и региональных органов разграничиваются законом с соблюдением единства государства."}
  ];
  function institutionStatus(status){return ({public_consultation:"Общественное обсуждение",referendum_scheduled:"Ожидает референдума",approved:"Одобрено",parliamentary_rejected:"Отклонено парламентом",referendum_rejected:"Отклонено на референдуме",campaign:"Идёт кампания",invalid:"Недостаточная явка"})[status]||"Завершено";}
  function renderInstitutions(game){
    const s=game.state||{},c=s.constitution||{},articles=Array.isArray(c.articles)&&c.articles.length?c.articles:DEFAULT_CONSTITUTION_ARTICLES,turn=Number(game.turn_number||0),government=s.phase==="government";
    setText("constitutionVersion","Редакция №"+Number(c.version||1));setText("constitutionArticleCount",articles.length+" статей");
    const art=$("constitutionArticles");if(art){art.replaceChildren();articles.forEach((item,i)=>{const card=node("article","constitution-article");card.append(node("div","constitution-article-number","СТАТЬЯ "+String(i+1).padStart(2,"0")),node("h4","",item.title),node("p","",item.text));art.append(card);});}
    const proposals=Array.isArray(c.proposals)?c.proposals:[],amendRoot=$("amendmentHistory");
    if(amendRoot){amendRoot.replaceChildren();if(!proposals.length)amendRoot.append(node("div","loading-row","Поправки ещё не вносились."));proposals.slice(-4).reverse().forEach(item=>{const card=node("article","institution-process-card"),head=node("div","institution-process-head");head.append(node("b","",item.articleTitle||"Поправка"),node("span","institution-status",institutionStatus(item.status)));card.append(head,node("p","",item.reason||item.proposedText||""));const meta=[];if(item.consultationEndsTurn)meta.push("Обсуждение до месяца "+item.consultationEndsTurn);if(item.parliamentShare!==undefined)meta.push("Поддержка парламента "+number(item.parliamentShare,1)+"%");if(item.referendumTurn)meta.push("Референдум после месяца "+item.referendumTurn);if(item.referendumShare!==undefined)meta.push("Поддержка на референдуме "+number(item.referendumShare,1)+"%");if(meta.length)card.append(node("small","institution-process-meta",meta.join(" · ")));amendRoot.append(card);});}
    const active=[...proposals].reverse().find(x=>["public_consultation","referendum_scheduled"].includes(x.status));
    const p=$("voteAmendmentParliament"),cr=$("holdConstitutionReferendum");
    const parliamentDue=active&&active.status==="public_consultation"&&turn>=Number(active.consultationEndsTurn||999999);
    if(p){p.disabled=busy||!government||!parliamentDue;p.textContent=parliamentDue?"Провести голосование парламента":"Парламент — после двух месяцев обсуждения";}
    const constitutionDue=active&&active.status==="referendum_scheduled"&&turn>=Number(active.referendumTurn||999999);
    if(cr){cr.disabled=busy||!government||!constitutionDue;cr.textContent=constitutionDue?"Открыть итог референдума":"Обязательный референдум после парламентского одобрения";}
    const propose=$("proposeAmendment");if(propose)propose.disabled=busy||!government||Number(s.actionPoints??2)<1||Boolean(active);
    const parliament=s.parliament||{};setText("parliamentBalance",parliament.governmentSeats!==undefined?Number(parliament.governmentSeats)+"% мест у правительственной коалиции · конституционное большинство — 2/3":"Состав парламента будет определён по итогам первых выборов.");
    const referendums=Array.isArray(s.referendums)?s.referendums:[],refRoot=$("referendumHistory");
    if(refRoot){refRoot.replaceChildren();if(!referendums.length)refRoot.append(node("div","loading-row","Референдумы ещё не проводились."));referendums.slice(-5).reverse().forEach(item=>{const card=node("article","institution-process-card"),head=node("div","institution-process-head");head.append(node("b","",item.question),node("span","institution-status",institutionStatus(item.status)));card.append(head,node("p","","«"+(item.yesLabel||"За")+"» / «"+(item.noLabel||"Против")+"»"));if(item.yesShare!==undefined)card.append(node("small","institution-process-meta","За: "+number(item.yesShare,1)+"% · Против: "+number(100-item.yesShare,1)+"% · Явка: "+number(item.turnout,1)+"%"));else card.append(node("small","institution-process-meta","Голосование после месяца "+item.voteTurn));refRoot.append(card);});}
    const running=[...referendums].reverse().find(x=>x.status==="campaign"),start=$("proposeReferendum"),hold=$("holdReferendum");
    if(start)start.disabled=busy||!government||Number(s.actionPoints??2)<1||Boolean(running);
    const referendumDue=running&&turn>=Number(running.voteTurn||999999);
    if(hold){hold.disabled=busy||!government||!referendumDue;hold.textContent=referendumDue?"Провести референдум":"Голосование после двух месяцев общественной кампании";}
  }

  function decreeEffectText(effects){
    const data=effects&&effects.preview?effects.preview:effects||{};
    const initial=Number(data.budgetCost||0),monthly=Number(data.monthlyCost||0),months=Number(data.durationMonths||0);
    if(!initial&&!monthly&&!months)return "Финансовые и календарные параметры не указаны в старой версии документа.";
    return "Первоначальное финансирование: "+money(initial)+". Ежемесячное финансирование: "+money(monthly)+". Срок исполнения: "+months+" месяцев. Общий предельный объём финансирования: "+money(initial+monthly*months)+".";
  }
  function fillOfficialDocument(decree,archived){
    setText("docTitle",decree.title);
    setText("decreeSummary",decree.summary||"");
    $("docBody").textContent=decree.body||"";
    setText("docNumber",String(decree.decree_number||"—"));
    setText("docDate",dateLabel(decree.created_at||currentGame&&currentGame.game_date));
    setText("docCountry",currentGame&&(currentGame.name_local||currentGame.name_en)||"ГОСУДАРСТВО");
    setText("docPresident",currentGame&&currentGame.president_name||"Президент");
    setText("docEffect",decreeEffectText(decree.effects&&decree.effects.preview?decree.effects.preview:decree.effects));
    $("decreePreview").classList.remove("hidden");
    $("generate").classList.add("hidden");
    $("decreePreview").dataset.archived=archived?"true":"false";
    const form=$("decreeForm");
    const orderLabel=form.querySelector('label[for="order"]');
    if(orderLabel)orderLabel.classList.toggle("hidden",!!archived);
    $("order").classList.toggle("hidden",!!archived);
    const title=form.querySelector("h3");
    if(title)title.textContent=archived?"Архив опубликованных нормативных актов":"Подготовить президентский указ";
    const intro=form.querySelector("p");
    if(intro)intro.textContent=archived?"Официальная копия ранее опубликованного и зарегистрированного указа.":"Опишите инициативу. Сервер подготовит проект указа с финансовыми условиями и сроком исполнения.";
    $("publishDecree").classList.toggle("hidden",!!archived);
  }
  function renderDecrees(items){
    const root=$("decreeHistory");if(!root)return;root.replaceChildren();decreeCache.clear();
    const published=(items||[]).filter(item=>item.status==="published");
    if(!published.length){root.append(node("div","loading-row","Опубликованных указов пока нет."));return;}
    published.forEach(item=>{
      decreeCache.set(String(item.id),item);
      const row=node("article","decree-row"),copy=node("div","decree-history-copy");
      copy.append(node("b","","Указ №"+item.decree_number+" · "+item.title),
        node("p","",item.summary||String(item.body||"").slice(0,200)),
        node("small","","ОПУБЛИКОВАНО · "+dateLabel(item.published_at||item.created_at)));
      const open=node("button","decree-open-button","Открыть документ");
      open.type="button";open.dataset.openDecree=item.id;
      row.append(copy,open);root.append(row);
    });
  }

  function actionKindLabel(kind){
    const labels={
      public_speech:"Выступление перед гражданами",
      public_service:"Общественные услуги и закупки",
      campaigning:"Предвыборная работа",
      policy_promise:"Предвыборное обещание",
      coalition:"Коалиционные переговоры",
      patronage:"Патронаж и назначения",
      corruption:"Коррупционная схема",
      institutional_capture:"Давление на институты",
      coup_attempt:"Попытка переворота",
      other:"Политическое действие"
    };
    return labels[kind]||"Политическое действие";
  }

  function setElectionTab(tab){
    electionTab=tab==="actions"?"actions":"position";
    const root=$("electionIssue");if(!root)return;
    root.querySelectorAll("[data-election-tab]").forEach(button=>{
      const active=button.dataset.electionTab===electionTab;
      button.classList.toggle("active",active);
      button.setAttribute("aria-selected",active?"true":"false");
    });
    root.querySelectorAll("[data-election-tab-panel]").forEach(panel=>{
      panel.classList.toggle("hidden",panel.dataset.electionTabPanel!==electionTab);
    });
  }

  function renderCampaignActionHistory(root,actions){
    if(!root)return;
    root.replaceChildren();
    const items=(Array.isArray(actions)?actions:[]).slice(-6).reverse();
    if(!items.length){
      root.append(node("div","campaign-history-empty","Действий пока нет. Первые встречи и решения появятся здесь."));
      return;
    }
    items.forEach(item=>{
      const card=node("article","campaign-action-card");
      const head=node("div","campaign-action-card-head");
      head.append(node("b","",actionKindLabel(item.kind)));
      if(item.headline&&item.headline!==actionKindLabel(item.kind))head.append(node("small","campaign-action-headline",item.headline));
      head.append(node("small","campaign-action-date",dateLabel(item.createdAt)));
      card.append(head);
      card.append(node("p","campaign-action-original",item.text||""));
      if(item.analysis)card.append(node("p","campaign-action-analysis",item.analysis));
      if(item.publicReaction&&item.publicReaction!=="[object Object]")card.append(node("p","campaign-action-reaction","Реакция общества: "+item.publicReaction));
      const effects=Object.entries(item.voterEffects||{}).filter(([,value])=>Number(value)!==0);
      if(effects.length){
        const chips=node("div","campaign-action-effects");
        const names={workers:"Работающие",business:"Бизнес",rural:"Регионы",youth:"Молодёжь",publicSector:"Госсектор",conservative:"Консерваторы"};
        effects.forEach(([key,value])=>chips.append(node("span",Number(value)>=0?"effect-positive":"effect-negative",(names[key]||key)+" "+(Number(value)>0?"+":"")+number(value,1))));
        card.append(chips);
      }
      const stateEffects=Object.entries(item.changes||{}).filter(([,value])=>Number(value)!==0);
      if(stateEffects.length){
        const names={treasury:"Казначейство",budgetBalance:"Бюджет",debt:"Долг",publicServices:"Госуслуги",healthcare:"Здравоохранение",education:"Образование",infrastructure:"Инфраструктура",corruption:"Коррупция",stability:"Стабильность",democracyIndex:"Демократия",approval:"Одобрение"};
        const details=stateEffects.map(([key,value])=>(names[key]||key)+" "+(Number(value)>0?"+":"")+number(value,2)).join(" · ");
        card.append(node("small","campaign-action-impact","Изменения страны: "+details));
      }
      if(item.coup){
        const verdict=item.coup.success?"Попытка переворота удалась":"Попытка переворота провалилась";
        card.append(node("strong",item.coup.success?"campaign-action-danger":"campaign-action-warning",verdict+" · Расчётный шанс "+item.coup.chance+"%"));
      }
      root.append(card);
    });
  }

  function renderElection(game){
    const phase=String((game.state||{}).phase||"government");
    const active=phase==="election_campaign"||phase==="election";
    const panel=$("electionPanel"),government=$("governmentView");
    if(panel)panel.classList.toggle("hidden",!active);
    if(government)government.classList.toggle("hidden",active);
    if(!active)return;

    const state=game.state||{},election=state.election||{};
    const agenda=Array.isArray(election.agenda)?election.agenda:[];
    const decisions=Array.isArray(election.decisions)?election.decisions:[];
    const actions=Array.isArray(state.politicalActions)?state.politicalActions:[];
    const index=Math.max(0,Number(election.issueIndex||0));
    const current=agenda[index]||null;
    const support=Number(election.candidateSupport||0);
    const completed=index>=agenda.length&&agenda.length>0;
    const activeCampaignEvent=state.campaignEvent&&state.campaignEvent.status==="active"?state.campaignEvent:null;
    if(activeCampaignEvent)electionTab="actions";

    setText("electionTitle",election.type||"Национальная избирательная кампания");
    setText("electionRound",election.firstElection?"ПЕРВЫЕ ВЫБОРЫ":"ПЕРЕИЗБРАНИЕ · ТУР "+(election.round||2));
    setText("electionDate",dateLabel(election.scheduledDate||game.game_date));
    setText("electionDescription","Формируйте собственную программу, работайте с избирателями и отслеживайте, как решения меняют отношение разных групп к вашей партии.");
    setText("electionCandidate",game.president_name);
    setText("electionParty",election.partyName||"Ваша политическая партия");
    const photo=$("electionPortrait");
    if(photo)photo.replaceChildren(portraitNode(state.presidentPortrait||"p01"));
    setText("candidateSupport",support.toFixed(1)+"%");
    const candidateBar=$("candidateSupportBar");
    if(candidateBar)candidateBar.style.width=Math.min(100,support)+"%";
    const partyPollRoot=$("partyPollList");
    if(partyPollRoot){
      partyPollRoot.replaceChildren();
      const fallbackOpposition=[
        {name:"Социал-демократическая партия",support:(100-support)*0.36},
        {name:"Либеральный союз",support:(100-support)*0.27},
        {name:"Консервативный блок",support:(100-support)*0.21},
        {name:"Партия зелёных и регионов",support:(100-support)*0.16}
      ];
      const opponents=Array.isArray(election.partyPoll)
        ? election.partyPoll.filter(party=>!party.isPlayer)
        : fallbackOpposition;
      opponents.forEach(party=>{
        const row=node("div","poll-row opposition");
        const head=node("div","");
        head.append(node("span","",String(party.name||"Другая партия")),node("b","",Number(party.support||0).toFixed(1)+"%"));
        const track=node("div","poll-track"),bar=node("i");
        bar.style.width=clamp(party.support||0,0,100)+"%";
        track.append(bar);row.append(head,track);partyPollRoot.append(row);
      });
    }
    setText("campaignActionsRemaining",agenda.length?Math.min(index,agenda.length)+" / "+agenda.length:"—");
    setText("electionConsequences",
      "Доверие к программе: "+number(election.policyCredibility??50,0)+"/100 · Институциональное доверие: "+number(election.institutionalTrust??50,0)+"/100 · Бюджетные обязательства: "+number(election.fiscalImpactPct??0,2)+"% ВВП");

    const groupRoot=$("campaignGroupPolls");
    if(groupRoot){
      groupRoot.replaceChildren();
      const labels={workers:"Работающие",business:"Предприниматели",rural:"Сельские регионы",youth:"Молодёжь",publicSector:"Госсектор",conservative:"Консервативные избиратели"};
      const groups=election.voterGroups||{};
      Object.entries(labels).forEach(([key,label])=>{
        const value=clamp(groups[key]??support,0,100);
        const row=node("div","campaign-group-row"),head=node("div","campaign-group-head");
        head.append(node("span","",label),node("b","",Math.round(value)+"%"));
        const track=node("div","campaign-group-track"),fill=node("i");
        fill.style.width=value+"%";track.append(fill);row.append(head,track);groupRoot.append(row);
      });
    }

    const issueRoot=$("electionIssue");
    if(issueRoot){
      issueRoot.replaceChildren();
      const tabs=node("div","campaign-tabs");
      const positionTab=node("button","campaign-tab-button","Политическая позиция");
      positionTab.type="button";positionTab.dataset.electionTab="position";
      const actionsTab=node("button","campaign-tab-button","Действия");
      actionsTab.type="button";actionsTab.dataset.electionTab="actions";
      tabs.append(positionTab,actionsTab);
      issueRoot.append(tabs);

      const positionPanel=node("section","campaign-tab-panel");
      positionPanel.dataset.electionTabPanel="position";
      if(current){
        const intro=node("div","campaign-issue-intro");
        intro.append(node("div","campaign-issue-number","ВОПРОС "+(index+1)+" ИЗ "+agenda.length));
        intro.append(node("h3","",current.title||"Политический выбор"));
        intro.append(node("p","",current.context||"Стране требуется политическое решение."));
        intro.append(node("h4","",current.question||"Какую позицию должна занять ваша партия?"));
        positionPanel.append(intro);

        const metricRoot=node("div","campaign-indicators");
        const metricFormats={
          treasury:v=>money(v),debt:v=>number(v,1)+"% ВВП",taxRate:v=>number(v,1)+"%",
          inflation:v=>number(v,1)+"%",unemployment:v=>number(v,1)+"%",
          gdpGrowth:v=>(Number(v)>0?"+":"")+number(v,1)+"%",
          infrastructure:v=>number(v,0)+"/100",publicServices:v=>number(v,0)+"/100",
          corruption:v=>number(v,0)+"/100",stability:v=>number(v,0)+"/100",
          approval:v=>number(v,0)+"%",militaryPower:v=>number(v,0)+"/100"
        };
        (current.indicators||[]).forEach(metric=>{
          const value=Number(state[metric.key]??0),cell=node("div","campaign-indicator");
          cell.append(node("small","",metric.label||metric.key),node("b","",metricFormats[metric.key]?metricFormats[metric.key](value):number(value,1)+(metric.suffix||"")));
          metricRoot.append(cell);
        });
        if(metricRoot.childNodes.length)positionPanel.append(metricRoot);

        const form=node("section","campaign-freeform");
        form.append(node("div","campaign-choice-kicker","ВАША ПОЛИТИЧЕСКАЯ ПОЗИЦИЯ"));
        form.append(node("p","campaign-choice-description","Опишите собственный курс партии: конкретные меры, кому они помогут, сколько будут стоить, кто отвечает за исполнение и какие компромиссы вы готовы принять."));
        const proposal=node("textarea","campaign-proposal-input");
        proposal.id="campaignProposal";proposal.maxLength=4000;
        proposal.placeholder="Например: предлагаю перенести часть налоговой нагрузки с фонда оплаты труда на сверхприбыль монополий. Поступления направить на модернизацию региональных больниц. Для контроля расходов публиковать все контракты...";
        proposal.disabled=busy;bindLocalDraft(proposal,"campaignProposal");form.append(proposal);
        const submit=node("button","primary-button","Передать позицию на анализ →");
        submit.type="button";submit.dataset.electionProposal="true";submit.disabled=busy;form.append(submit);
        positionPanel.append(form);
      }else if(agenda.length){
        positionPanel.append(node("div","campaign-complete-title","Политическая программа сформирована"));
        positionPanel.append(node("p","campaign-complete-copy","Вы определили позицию партии по всем ключевым вопросам. Теперь избиратели оценят последовательность, выполнимость и последствия программы."));
      }else{
        positionPanel.append(node("div","campaign-complete-title","Сохранение старой версии кампании"));
        positionPanel.append(node("p","campaign-complete-copy","Эта кампания была создана до появления новой системы выборов. Начните новую кампанию, чтобы получить повестку из шести содержательных вопросов."));
      }
      issueRoot.append(positionPanel);

      const actionPanel=node("section","campaign-tab-panel");
      actionPanel.dataset.electionTabPanel="actions";
      actionPanel.append(node("div","campaign-choice-kicker","ПУБЛИЧНАЯ ПОЛИТИКА"));
      actionPanel.append(node("h3","","Кампания вживую"));
      actionPanel.append(node("p","campaign-choice-description","Выходите на дебаты с оппонентом, отвечайте журналистам на неудобные вопросы и встречайтесь с избирателями. Каждое мероприятие проходит в несколько раундов: сначала вы получаете конкретный вопрос, затем отвечаете своими словами, а ИИ оценивает аргументы и реакцию разных групп."));
      const eventPoints=Math.max(0,Number(state.actionPoints??2));
      const pointsLine=node("div","campaign-event-points","Доступно очков действий: "+eventPoints+" · одно мероприятие расходует 1 очко после завершения");
      actionPanel.append(pointsLine);

      const activeEvent=activeCampaignEvent;
      if(activeEvent){
        const stage=node("section","campaign-event-live");
        const head=node("div","campaign-event-live-head");
        const headCopy=node("div","");
        headCopy.append(node("span","campaign-event-kicker",String(activeEvent.label||"ПОЛИТИЧЕСКОЕ МЕРОПРИЯТИЕ").toUpperCase()));
        headCopy.append(node("h4","",activeEvent.title||"Мероприятие кампании"));
        headCopy.append(node("small","",[(activeEvent.venue||""),("Раунд "+activeEvent.round+" из "+activeEvent.maxRounds)].filter(Boolean).join(" · ")));
        head.append(headCopy,node("span","campaign-event-live-dot","В ЭФИРЕ"));
        stage.append(head);
        if(activeEvent.opening)stage.append(node("p","campaign-event-opening",activeEvent.opening));
        if(activeEvent.topic)stage.append(node("div","campaign-event-topic","ТЕМА · "+activeEvent.topic));
        const previousTurns=Array.isArray(activeEvent.transcript)?activeEvent.transcript:[];
        if(previousTurns.length){
          const previousRoot=node("div","campaign-event-prior-rounds");
          previousTurns.forEach(turn=>{
            const exchange=node("article","campaign-event-history-turn");
            exchange.append(node("small","",turn.questioner||"Вопрос"),node("p","",turn.question||""));
            exchange.append(node("small","","Ваш предыдущий ответ"),node("p","",turn.response||""));
            if(turn.analysis)exchange.append(node("p","campaign-event-history-analysis",turn.analysis));
            if(turn.publicReaction)exchange.append(node("p","campaign-event-history-reaction","Реакция аудитории: "+turn.publicReaction));
            previousRoot.append(exchange);
          });
          stage.append(previousRoot);
        }
        const question=node("article","campaign-event-question");
        question.append(node("small","",activeEvent.questioner||"Вопрос"),node("p","",activeEvent.question||"Вопрос мероприятия"));
        stage.append(question);
        const answer=node("textarea","campaign-event-answer");
        answer.id="campaignEventAnswer";answer.maxLength=3000;
        answer.placeholder="Ваш ответ. Объясните позицию, назовите конкретные меры, сроки, ответственных и источники финансирования...";
        answer.disabled=busy;bindLocalDraft(answer,"campaignEventAnswer-"+activeEvent.id);
        stage.append(answer);
        const submit=node("button","primary-button","Ответить и продолжить →");
        submit.type="button";submit.dataset.campaignEventRespond=activeEvent.id;
        submit.disabled=busy||hasPendingBackgroundJobs();
        stage.append(submit);
        actionPanel.append(stage);
      }else{
        const eventGrid=node("div","campaign-event-grid");
        const eventCards=[
          ["debate","Публичные дебаты","Оппонент атакует вашу программу. Нужно защитить решения, выдержать уточнения и не уйти от неудобных тем.","ДУЭЛЬ С ОППОЗИЦИЕЙ"],
          ["press","Пресс-конференция","Журналисты задают вопросы о провалах, цифрах, обещаниях и ответственности правительства.","ВОПРОСЫ СМИ"],
          ["meeting","Встреча с избирателями","Личный разговор с людьми, которые ждут решения конкретной проблемы своего сообщества.","РАЗГОВОР С ГРАЖДАНАМИ"]
        ];
        eventCards.forEach(([type,title,description,kicker])=>{
          const card=node("article","campaign-event-choice");
          card.append(node("small","campaign-event-choice-kicker",kicker));
          card.append(node("h4","",title));
          card.append(node("p","",description));
          const start=node("button","primary-button",type==="debate"?"Выйти на дебаты →":type==="press"?"Открыть пресс-конференцию →":"Назначить встречу →");
          start.type="button";start.dataset.campaignEventStart=type;
          start.disabled=busy||hasPendingBackgroundJobs()||eventPoints<1;
          card.append(start);eventGrid.append(card);
        });
        actionPanel.append(eventGrid);
        const meetingDetails=node("div","campaign-event-settings");
        const groupWrap=node("label","campaign-event-setting");
        groupWrap.append(node("span","","Целевая аудитория для встречи"));
        const groupSelect=node("select");groupSelect.id="campaignMeetingGroup";
        [["workers","Работающие и профсоюзы"],["business","Предприниматели"],["rural","Сельские жители"],["youth","Молодёжь"],["publicSector","Врачи, учителя и госслужащие"],["conservative","Консервативные избиратели"]].forEach(([value,label])=>{
          const option=node("option","",label);option.value=value;groupSelect.append(option);
        });
        groupWrap.append(groupSelect);
        const locationWrap=node("label","campaign-event-setting");
        locationWrap.append(node("span","","Город или регион"));
        const locationInput=node("input");locationInput.id="campaignEventLocation";locationInput.maxLength=140;
        locationInput.placeholder="Например, северные регионы или город...";
        bindLocalDraft(locationInput,"campaignEventLocation");locationWrap.append(locationInput);
        meetingDetails.append(groupWrap,locationWrap);
        actionPanel.append(meetingDetails);
      }

      const freeform=node("details","campaign-freeform campaign-freeform-extra");
      const summary=node("summary","","Другое политическое действие");
      freeform.append(summary,node("p","campaign-choice-description","Опишите самостоятельный шаг кампании: запуск штаба, коалиционные переговоры, адресная агитация, волонтёрская сеть или публичная инициатива."));
      const activityInput=node("textarea","campaign-proposal-input");
      activityInput.id="campaignActivityInput";activityInput.maxLength=3000;
      activityInput.placeholder="Опишите действие, его цель, участников и ожидаемый результат...";
      activityInput.disabled=busy;bindLocalDraft(activityInput,"campaignActivityInput");
      const activityButton=node("button","secondary-button","Отправить действие на анализ →");
      activityButton.type="button";activityButton.dataset.electionActivity="true";activityButton.disabled=busy||hasPendingBackgroundJobs();
      freeform.append(activityInput,activityButton);
      if(!activeEvent)actionPanel.append(freeform);

      const completedEvents=Array.isArray(state.campaignEventHistory)?state.campaignEventHistory:[];
      if(completedEvents.length){
        actionPanel.append(node("div","campaign-history-heading","ПОСЛЕДНИЕ МЕРОПРИЯТИЯ"));
        const eventHistory=node("div","campaign-event-history");
        completedEvents.slice(-4).reverse().forEach(item=>{
          const card=node("article","campaign-event-history-card");
          card.append(node("b","",item.title||item.label||"Мероприятие кампании"));
          card.append(node("small","",item.venue||""));
          (item.transcript||[]).forEach(turn=>{
            const exchange=node("div","campaign-event-history-turn");
            exchange.append(node("small","",turn.questioner||"Вопрос"),node("p","",turn.question||""));
            exchange.append(node("small","","Ваш ответ"),node("p","",turn.response||""));
            if(turn.analysis)exchange.append(node("p","campaign-event-history-analysis",turn.analysis));
            if(turn.publicReaction)exchange.append(node("p","campaign-event-history-reaction","Реакция зала: "+turn.publicReaction));
            card.append(exchange);
          });
          if(item.lastPressCoverage)card.append(node("p","campaign-event-history-reaction","В СМИ: "+item.lastPressCoverage));
          eventHistory.append(card);
        });
        actionPanel.append(eventHistory);
      }

      actionPanel.append(node("div","campaign-history-heading","ДРУГИЕ ШАГИ КАМПАНИИ"));
      const history=node("div","campaign-action-history");
      renderCampaignActionHistory(history,actions);
      actionPanel.append(history);
      issueRoot.append(actionPanel);
      setElectionTab(electionTab);
    }

    const history=$("electionDecisionHistory");
    if(history){
      history.replaceChildren();
      if(!decisions.length)history.append(node("div","campaign-history-empty","Решения ещё не приняты."));
      decisions.forEach((decision,i)=>{
        const row=node("div","campaign-history-row");
        row.append(node("span","campaign-history-index",String(i+1).padStart(2,"0")));
        const copy=node("div","campaign-history-copy");
        copy.append(node("b","",decision.issueTitle||decision.issueId||"Вопрос"),node("small","",decision.choiceTitle||decision.choiceId||""));
        row.append(copy);history.append(row);
      });
    }

    const progress=$("campaignProgress");
    if(progress)progress.style.width=(agenda.length?Math.min(100,index/agenda.length*100):0)+"%";
    const vote=$("electionVote");
    if(vote){
      vote.classList.toggle("hidden",!completed);
      vote.disabled=!completed||busy||hasPendingBackgroundJobs()||Boolean(activeCampaignEvent);
      vote.textContent=completed?"Провести национальные выборы →":"Сначала завершите программу";
    }
    document.querySelectorAll("[data-election-proposal],[data-election-activity]").forEach(button=>button.disabled=busy);
  }

  function renderProjects(game){
    const root=$("activePrograms");if(!root)return;root.replaceChildren();
    const state=game.state||{};
    const isGovernment=String(state.phase||"")==="government";
    const projects=Array.isArray(state.projects)?state.projects:[],active=projects.filter(item=>item.status==="active");
    if(!active.length){
      root.append(node("div","programs-empty",isGovernment
        ?"Активных проектов пока нет. Выберите готовую программу или разработайте собственную."
        :"Государственные программы откроются после победы на выборах и вступления в должность."));
    }
    active.forEach(project=>{
      const card=node("article","active-program-card"),head=node("div","active-program-head"),copy=node("div","");
      copy.append(node("b","",project.title),node("small","",project.category+" · "+project.monthsCompleted+"/"+project.durationMonths+" месяцев"));
      head.append(copy,node("span",project.paused?"program-paused":"program-running",project.paused?"ПРИОСТАНОВЛЕНА — НЕТ СРЕДСТВ":"В РАБОТЕ"));
      const track=node("div","program-progress"),fill=node("i");
      fill.style.width=Math.min(100,100*Number(project.monthsCompleted||0)/Math.max(1,Number(project.durationMonths||1)))+"%";track.append(fill);
      const foot=node("div","active-program-foot");
      foot.append(node("small","","Первоначальный платёж: "+money(project.upfrontCost)+" · В месяц: "+money(project.monthlyCost)));
      const cancel=node("button","","Остановить");cancel.type="button";cancel.dataset.programCancel=project.projectId;cancel.disabled=busy;foot.append(cancel);
      card.append(head,track,foot);root.append(card);
    });
    document.querySelectorAll("[data-program-start]").forEach(button=>{
      const exists=active.some(item=>item.projectId===button.dataset.programStart);
      button.disabled=busy||!isGovernment||exists||active.length>=3||Number(state.actionPoints??2)<1;
      button.textContent=!isGovernment?"После выборов":exists?"Уже запущена":"Запустить";
      button.title=!isGovernment?"Доступно после вступления в должность":active.length>=3?"Можно вести не более трёх программ одновременно":"";
    });
    const create=$("createStateProgram");
    if(create){
      create.disabled=busy||!isGovernment;
      create.textContent=isGovernment?"＋ Собственная программа":"Доступно после выборов";
      create.title=isGovernment?"Подготовить собственную программу через проект президентского указа":"Доступно после победы на выборах";
    }
  }


  function ensureAiDialog(){
    let dialog=$("aiDiplomacyDialog");if(dialog)return dialog;
    const style=node("style");
    style.textContent=".campaign-freeform,.political-action-panel{margin:22px 0;padding:22px;border:1px solid #dce3ec;border-radius:16px;background:#fff}.campaign-proposal-input,.political-action-input{display:block;width:100%;min-height:150px;margin:14px 0;padding:15px;border:1px solid #ccd6e2;border-radius:12px;font:inherit;line-height:1.5;resize:vertical}.ai-diplomacy-dialog{width:min(760px,calc(100vw - 28px));max-height:88vh;padding:0;border:1px solid #d9e0e8;border-radius:18px;background:#fff;color:#172235;box-shadow:0 22px 80px #14223833}.ai-diplomacy-dialog::backdrop{background:#14223899;backdrop-filter:blur(4px)}.ai-diplomacy-head{display:flex;justify-content:space-between;gap:16px;padding:20px 24px;border-bottom:1px solid #e4e9ef}.ai-diplomacy-messages{display:flex;flex-direction:column;gap:12px;overflow:auto;max-height:48vh;padding:20px 24px}.ai-message{max-width:88%;padding:12px 15px;border-radius:14px;white-space:pre-wrap;line-height:1.5}.ai-message.player{align-self:flex-end;background:#e8f0f8}.ai-message.leader{align-self:flex-start;background:#f1f3f6}.ai-diplomacy-form{padding:16px 24px 22px;border-top:1px solid #e4e9ef}.ai-diplomacy-form textarea{width:100%;min-height:94px;padding:13px;border:1px solid #ccd6e2;border-radius:12px;font:inherit;resize:vertical}.ai-diplomacy-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:10px}";
    document.head.append(style);
    dialog=node("dialog","ai-diplomacy-dialog");dialog.id="aiDiplomacyDialog";
    dialog.innerHTML='<div class="ai-diplomacy-head"><div><div class="campaign-choice-kicker">ДИПЛОМАТИЧЕСКИЙ КАНАЛ</div><h2 id="aiDiplomacyCountry">Переговоры</h2><small id="aiDiplomacyScore">История контактов и позиция партнёра учитываются</small></div><button type="button" id="closeAiDiplomacy" class="secondary-button">Закрыть</button></div><div class="ai-diplomacy-messages" id="aiDiplomacyMessages"></div><form class="ai-diplomacy-form" id="aiDiplomacyForm"><textarea id="aiDiplomacyInput" maxlength="2500" placeholder="Ваше обращение к главе иностранного государства..." required></textarea><div class="ai-diplomacy-actions"><button type="submit" class="primary-button" id="sendAiDiplomacy">Отправить сообщение</button></div></form>';
    document.body.append(dialog);
    $("closeAiDiplomacy").addEventListener("click",()=>dialog.close());
    bindLocalDraft($("aiDiplomacyInput"),"aiDiplomacyInput");
    $("aiDiplomacyForm").addEventListener("submit",event=>{
      event.preventDefault();const textValue=$("aiDiplomacyInput").value.trim();
      if(!textValue||!activeDiplomacyRelation||busy)return;
      const relationId=activeDiplomacyRelation;
      try{
        enqueueBackgroundTask({kind:"diplomatic-message",route:"/api/presidential/ai/diplomacy/message",payload:{relationId,message:textValue}});
        $("aiDiplomacyInput").value="";clearLocalDraft("aiDiplomacyInput");
      }catch(error){toast(error.message);}
    });
    return dialog;
  }
  let activeDiplomacyRelation=null;
  function aiApi(){return window.PRESIDENTIAL_AUTH&&window.PRESIDENTIAL_AUTH.aiApi;}
  function appendAiDiplomacyMessage(role,content){
    const root=$("aiDiplomacyMessages");if(!root)return;
    const bubble=node("div","ai-message "+(role==="leader"?"leader":"player"),content);
    root.append(bubble);root.scrollTop=root.scrollHeight;
  }
  async function loadAiDiplomacyHistory(relationId){
    const root=$("aiDiplomacyMessages");if(!root)return;root.replaceChildren(node("div","loading-row","Загружаем историю дипломатических контактов…"));
    try{
      const result=await aiApi()("/api/presidential/ai/diplomacy/history?relationId="+encodeURIComponent(relationId));
      root.replaceChildren();
      (result.messages||[]).forEach(item=>appendAiDiplomacyMessage(item.role,item.content));
      if(!result.messages||!result.messages.length)root.append(node("div","loading-row","Начните переговоры. Иностранный лидер будет отвечать с учётом интересов своей страны и истории отношений."));
      const relation=result.relation||{};
      setText("aiDiplomacyScore","Отношения: "+(Number(relation.relation_score)>0?"+":"")+relation.relation_score+" · "+relationLabel(relation.relation_score,relation.status));
    }catch(error){root.replaceChildren(node("div","loading-row","Не удалось загрузить переговоры: "+error.message));}
  }
  async function openAiDiplomacy(relationId,country){
    activeDiplomacyRelation=relationId;const dialog=ensureAiDialog();
    setText("aiDiplomacyCountry",country||"Иностранный лидер");
    $("aiDiplomacyMessages").replaceChildren();$("aiDiplomacyInput").value="";
    dialog.showModal();await loadAiDiplomacyHistory(relationId);
  }
  function renderPoliticalActionPanel(game){
    const host=$("governmentView");if(!host)return;
    let panel=$("politicalActionPanel");
    if(!panel){
      panel=node("section","political-action-panel");panel.id="politicalActionPanel";
      panel.append(node("div","campaign-choice-kicker","ПОЛИТИЧЕСКИЕ ДЕЙСТВИЯ"));
      panel.append(node("h3","","Президентские решения"));
      panel.append(node("p","","Опишите действие своими словами: обращение к гражданам, решение социальной проблемы, политическую сделку, коррупционную схему или попытку захвата власти. ИИ оценит реакцию общества, а последствия будут применены игровым движком."));
      const input=node("textarea","political-action-input");input.id="politicalActionInput";input.maxLength=3000;
      input.placeholder="Опишите своё действие и его цель...";
       bindLocalDraft(input,"politicalActionInput");
      const button=node("button","primary-button","Провести действие →");button.type="button";button.id="politicalActionSubmit";
      panel.append(input,button);
      const history=node("div","political-action-history");history.id="politicalActionHistory";panel.append(history);
      host.prepend(panel);
      button.addEventListener("click",()=>{
        const action=$("politicalActionInput").value.trim();if(action.length<8||busy)return toast("Опишите действие подробнее.");
        if(hasPendingBackgroundJobs())return toast("Сначала дождитесь выполнения предыдущего действия.");
        try{
          enqueueBackgroundTask({kind:"presidential-action",route:"/api/presidential/ai/election/action",payload:{action}});
          $("politicalActionInput").value="";clearLocalDraft("politicalActionInput");
        }catch(error){toast(error.message);}
      });
    }
    const actions=Array.isArray(game.state&&game.state.politicalActions)?game.state.politicalActions:[];
    const history=$("politicalActionHistory");
    if(history){
      history.replaceChildren();
      actions.slice(-4).reverse().forEach(item=>{
        const card=node("article","campaign-history-row");
        const copy=node("div","campaign-history-copy");
        copy.append(node("b","",item.coup?(item.coup.success?"Попытка переворота — успех":"Попытка переворота — провал"):actionKindLabel(item.kind)));
        copy.append(node("small","",item.text||""));
        if(item.analysis)copy.append(node("p","",item.analysis));
        card.append(copy);history.append(card);
      });
      if(!actions.length)history.append(node("small","campaign-history-empty","История президентских действий пока пуста."));
    }
    $("politicalActionSubmit").disabled=busy||hasPendingBackgroundJobs();
    $("politicalActionInput").disabled=busy||hasPendingBackgroundJobs();
  }
  function renderGame(payload){
    if(!payload||!payload.game){currentGame=null;return;}
    currentPayload=payload;currentGame=payload.game;
    renderIdentity(currentGame);renderMetrics(currentGame);renderElection(currentGame);
    renderMinisters(payload.ministers);renderEvents(payload.events);renderRelations(payload.relations);
    renderUnits(payload.units);renderMilitary(payload);renderDecrees(payload.decrees);renderProjects(currentGame);renderInstitutions(currentGame);renderPoliticalActionPanel(currentGame);
    setText("saveStatus","Сохранение синхронизировано");
    const advance=$("advanceTurn"),newGame=$("newGame");
    if(advance)advance.disabled=busy||hasPendingBackgroundJobs()||["election_campaign","election"].includes(currentGame.state&&currentGame.state.phase);
    if(newGame)newGame.disabled=busy||hasPendingBackgroundJobs();
  }

  let autonomousRefreshInFlight=false;
  window.setInterval(async()=>{
    if(!currentGame||busy||document.hidden||autonomousRefreshInFlight)return;
    const hasAutonomousWar=(currentPayload&&Array.isArray(currentPayload.wars)||[]).some(w=>w.status==="active"&&w.command_mode==="ai");
    if(!hasAutonomousWar)return;
    autonomousRefreshInFlight=true;
    try{const fresh=await api()("/api/presidential/game/current");if(fresh&&fresh.game)renderGame(fresh);}
    catch(error){console.warn("Autonomous war refresh failed:",error);}
    finally{autonomousRefreshInFlight=false;}
  },60000);

  async function refreshGame(){
    if(!api()||!window.PRESIDENTIAL_AUTH||!window.PRESIDENTIAL_AUTH.user)return;
    setText("saveStatus","Синхронизация…");
    try{
      let result=await api()("/api/presidential/game/current");
      if(!result.game){currentGame=null;if(busy)needsSetupAfterBusy=true;else await openSetup();return;}
      const election=result.game.state&&result.game.state.election||{};
      const inElection=["election_campaign","election"].includes(String(result.game.state&&result.game.state.phase||""));
      if(inElection&&Number(election.baselineVersion||0)<4&&window.PRESIDENTIAL_AUTH.aiApi){
        try{
          await window.PRESIDENTIAL_AUTH.aiApi("/api/presidential/ai/election/initialize",{method:"POST",body:"{}"});
          result=await api()("/api/presidential/game/current");
        }catch(baselineError){
          console.warn("Election polling baseline was not normalized yet:",baselineError);
        }
      }
      renderGame(result);
    }catch(error){setText("saveStatus","Ошибка сохранения");toast("Не удалось загрузить кампанию: "+error.message);}
  }

  async function withBusy(button,work,successMessage){
    if(busy)return;
    busy=true;
    if(button)button.disabled=true;
    document.querySelectorAll("button[data-election-action],button[data-election-proposal],button[data-election-activity],button[data-program-start],button[data-ai-diplomacy]").forEach(el=>el.disabled=true);
    setText("saveStatus","Сохранение изменений…");
    try{
      const result=await work();
      if(result&&result.__backgroundQueued){
        if(result.id&&successMessage)outboxCallbacks.set(result.id,successMessage);
        return result;
      }
      await refreshGame();
      if(successMessage)toast(typeof successMessage==="function"?successMessage(result):successMessage);
      return result;
    }catch(error){toast("Действие не выполнено: "+actionErrorMessage(error));throw error;}
    finally{
      busy=false;
      if(button)button.disabled=false;
      if(currentGame)renderGame(currentPayload);
      else if(needsSetupAfterBusy){needsSetupAfterBusy=false;openSetup();}
    }
  }

  async function openSetup(){
    if(busy||!api())return;
    $("partyName").value="";
    $("difficulty").value="normal";
    setText("setupSelectionStatus","Страна, кандидат, возраст и биография будут определены случайно.");
    if(!$("setupDialog").open)$("setupDialog").showModal();
  }

  async function electionRequest(route,payload,button,message){
    try{await withBusy(button,()=>api()(route,{method:"POST",body:JSON.stringify(payload||{})}),message);}catch(_){}
  }

  document.querySelectorAll(".nav-link").forEach(link=>{
    link.addEventListener("click",()=>{
      document.querySelectorAll(".nav-link").forEach(item=>item.classList.remove("active"));link.classList.add("active");
      if(link.getAttribute("href")==="#defense")window.setTimeout(()=>militaryLeafletMap&&militaryLeafletMap.invalidateSize({pan:false}),140);
    });
  });
  window.addEventListener("resize",()=>militaryLeafletMap&&window.setTimeout(()=>militaryLeafletMap&&militaryLeafletMap.invalidateSize({pan:false}),80));
  $("advanceTurn").addEventListener("click",async()=>{
    if(!currentGame||busy)return;
    const points=Number((currentGame.state||{}).actionPoints??2),warning=points>0?" Осталось "+points+" неиспользованных очка действий.":"";
    if(!confirm("Завершить текущий месяц и перейти к следующему? Экономика, проекты, министры и мировые события будут пересчитаны."+warning))return;
    try{await withBusy($("advanceTurn"),()=>api()("/api/presidential/game/advance",{method:"POST",body:"{}"}),result=>result&&result.event&&result.event.headline?"Наступил новый месяц. "+result.event.headline:"Наступил новый месяц.");}catch(_){}
  });
  $("newGame").addEventListener("click",()=>openSetup());
  $("closeSetup").addEventListener("click",()=>$("setupDialog").close());
  $("cancelSetup").addEventListener("click",()=>$("setupDialog").close());
  $("setupForm").addEventListener("submit",async event=>{
    event.preventDefault();
    const partyName=$("partyName").value.trim();
    if(partyName.length>80)return toast("Название партии слишком длинное.");
    if(currentGame&&!confirm("Начать новую кампанию? Текущее сохранение будет завершено."))return;
    const payload={partyName,difficulty:$("difficulty").value};
    clearAllLocalDrafts();
    try{
      await withBusy($("startCampaign"),()=>api()("/api/presidential/game/new",{method:"POST",body:JSON.stringify(payload)}),"Новая страна и кандидат определены случайно. Началась политическая кампания.");
      $("setupDialog").close();
    }catch(_){}
  });

  $("programCatalog").addEventListener("click",async event=>{
    const button=event.target.closest("[data-program-start]");if(!button||busy)return;
    const projectId=button.dataset.programStart;
    if(!confirm("Запустить долгосрочную программу? Потребуются первоначальный платёж, одно очко действий и ежемесячное финансирование. Результаты будут накапливаться постепенно."))return;
    try{await withBusy(button,()=>api()("/api/presidential/game/program",{method:"POST",body:JSON.stringify({action:"start",projectId})}),"Программа запущена. Результаты будут накапливаться по месяцам.");}catch(_){}
  });
  let forceNewDecreeForProgram=false;
  $("createStateProgram").addEventListener("click",()=>{
    if(!currentGame||String(currentGame.state&&currentGame.state.phase||"")!=="government"){
      return toast("Собственные государственные программы доступны после вступления в должность.");
    }
    forceNewDecreeForProgram=true;
    $("openDecree").click();
    const form=$("decreeForm");
    const eyebrow=form&&form.querySelector(".dialog-eyebrow");
    const heading=form&&form.querySelector(":scope > h3");
    const intro=form&&Array.from(form.children).find(el=>el.tagName==="P");
    if(eyebrow)eyebrow.textContent="ГОСУДАРСТВЕННАЯ ПРОГРАММА";
    if(heading)heading.textContent="Разработать собственную государственную программу";
    if(intro)intro.textContent="Опишите государственную проблему, цели, конкретные меры, сроки и предполагаемое финансирование. ИИ подготовит проект президентского указа; после публикации программа появится среди действующих проектов.";
    if($("order"))$("order").placeholder="Например: национальная программа модернизации сельских больниц, строительство фельдшерских пунктов, закупка оборудования, сроки и источники финансирования...";
  });
  $("activePrograms").addEventListener("click",async event=>{
    const button=event.target.closest("[data-program-cancel]");if(!button||busy)return;
    if(!confirm("Остановить программу? Уже потраченные средства не возвращаются."))return;
    try{await withBusy(button,()=>api()("/api/presidential/game/program",{method:"POST",body:JSON.stringify({action:"cancel",projectId:button.dataset.programCancel})}),"Программа остановлена.");}catch(_){}
  });
  $("electionIssue").addEventListener("click",event=>{
    const tab=event.target.closest("[data-election-tab]");
    if(tab){setElectionTab(tab.dataset.electionTab);return;}
    const button=event.target.closest("[data-election-proposal]");
    if(!button||busy)return;
    const proposal=$("campaignProposal")&&$("campaignProposal").value.trim();
    if(!proposal||proposal.length<10)return toast("Опишите политическое предложение подробнее.");
    try{
      enqueueBackgroundTask({kind:"election-position",route:"/api/presidential/ai/election/decision",payload:{proposal}});
      if($("campaignProposal"))$("campaignProposal").value="";
      clearLocalDraft("campaignProposal");
    }catch(error){toast(error.message);}
  });
  $("electionIssue").addEventListener("click",event=>{
    const button=event.target.closest("[data-election-activity]");
    if(!button||busy)return;
    const action=$("campaignActivityInput")&&$("campaignActivityInput").value.trim();
    if(!action||action.length<8)return toast("Опишите действие в кампании подробнее.");
    try{
      enqueueBackgroundTask({kind:"election-activity",route:"/api/presidential/ai/election/action",payload:{action}});
      if($("campaignActivityInput"))$("campaignActivityInput").value="";
      clearLocalDraft("campaignActivityInput");
    }catch(error){toast(error.message);}
  });
  $("electionIssue").addEventListener("click",event=>{
    const start=event.target.closest("[data-campaign-event-start]");
    if(start){
      if(busy||hasPendingBackgroundJobs())return toast("Дождитесь завершения предыдущего действия.");
      const eventType=start.dataset.campaignEventStart;
      const targetGroup=$("campaignMeetingGroup")&&$("campaignMeetingGroup").value||"workers";
      const location=$("campaignEventLocation")&&$("campaignEventLocation").value.trim()||"";
      try{
        enqueueBackgroundTask({kind:"campaign-event-start",route:"/api/presidential/ai/election/event/start",payload:{eventType,targetGroup,location}});
      }catch(error){toast(error.message);}
      return;
    }
    const respond=event.target.closest("[data-campaign-event-respond]");
    if(respond){
      if(busy||hasPendingBackgroundJobs())return toast("Дождитесь завершения предыдущего действия.");
      const response=$("campaignEventAnswer")&&$("campaignEventAnswer").value.trim();
      if(!response||response.length<12)return toast("Ответьте подробнее: нужны аргументы и конкретные обязательства.");
      const eventId=respond.dataset.campaignEventRespond;
      try{
        enqueueBackgroundTask({kind:"campaign-event-respond",route:"/api/presidential/ai/election/event/respond",payload:{eventId,response}});
        $("campaignEventAnswer").value="";
        clearLocalDraft("campaignEventAnswer-"+eventId);
      }catch(error){toast(error.message);}
    }
  });

  $("electionVote").addEventListener("click",async()=>{
    if(!currentGame||busy)return;
    if(!confirm("Передать программу партии избирателям и провести национальные выборы? Результат зависит от поддержки разных групп, финансовой реалистичности обещаний и доверия к институтам. При поражении кампания завершится."))return;
    try{
      await withBusy($("electionVote"),()=>api()("/api/presidential/game/election/vote",{method:"POST",body:"{}"}),result=>result&&result.won?"Победа! Вы получили "+result.voteShare+"% голосов. Начинается исполнение предвыборной программы.":"Поражение. Вы получили "+result.voteShare+"% голосов. Избиратели отвергли предложенный курс.");
    }catch(_){}
  });

  $("proposeAmendment").addEventListener("click",async()=>{
    if(!currentGame||busy)return;
    const articleId=$("constitutionArticleSelect").value,proposedText=$("amendmentText").value.trim(),reason=$("amendmentReason").value.trim();
    if(proposedText.length<30||reason.length<20)return toast("Нужны полный текст поправки и подробное обоснование.");
    if(!confirm("Начать двухмесячное общественное обсуждение? Затем потребуется 2/3 голосов парламента и обязательный референдум."))return;
    try{await withBusy($("proposeAmendment"),()=>api()("/api/presidential/game/constitution/propose",{method:"POST",body:JSON.stringify({articleId,proposedText,reason})}),"Поправка зарегистрирована. Началось общественное обсуждение.");$("amendmentText").value="";$("amendmentReason").value="";}catch(_){}
  });
  $("voteAmendmentParliament").addEventListener("click",async()=>{
    if(!currentGame||busy||!confirm("Провести голосование парламента? Для продолжения требуется 2/3 голосов."))return;
    try{await withBusy($("voteAmendmentParliament"),()=>api()("/api/presidential/game/constitution/parliament",{method:"POST",body:"{}"}),r=>r&&r.approved?"Поправка получила квалифицированное большинство. Назначен референдум.":"Парламент отклонил поправку.");}catch(_){}
  });
  $("holdConstitutionReferendum").addEventListener("click",async()=>{
    if(!currentGame||busy||!confirm("Подвести официальные итоги обязательного референдума по поправке к Конституции?"))return;
    try{await withBusy($("holdConstitutionReferendum"),()=>api()("/api/presidential/game/constitution/referendum",{method:"POST",body:"{}"}),r=>r&&r.approved?"Новая редакция Конституции вступила в силу.":"Избиратели не поддержали поправку.");}catch(_){}
  });
  $("proposeReferendum").addEventListener("click",async()=>{
    if(!currentGame||busy)return;
    const question=$("referendumQuestion").value.trim(),topic=$("referendumTopic").value,yesLabel=$("referendumYes").value.trim()||"Да",noLabel=$("referendumNo").value.trim()||"Нет";
    if(question.length<20)return toast("Формулировка вопроса должна содержать не менее 20 символов.");
    if(!confirm("Зарегистрировать референдум? До голосования пройдут два месяца общественной кампании."))return;
    try{await withBusy($("proposeReferendum"),()=>api()("/api/presidential/game/referendum/propose",{method:"POST",body:JSON.stringify({question,topic,yesLabel,noLabel})}),"Началась общественная кампания референдума.");$("referendumQuestion").value="";}catch(_){}
  });
  $("holdReferendum").addEventListener("click",async()=>{
    if(!currentGame||busy||!confirm("Закрыть голосование и объявить официальный результат референдума?"))return;
    try{await withBusy($("holdReferendum"),()=>api()("/api/presidential/game/referendum/hold",{method:"POST",body:"{}"}),r=>r&&r.approved?"Предложение получило поддержку большинства.":"Предложение не получило большинства или не набрало кворум.");}catch(_){}
  });

  $("relationsList").addEventListener("click",event=>{
    const button=event.target.closest("[data-ai-diplomacy]");if(!button||busy)return;
    openAiDiplomacy(button.dataset.aiDiplomacy,button.dataset.country||"Иностранное государство");
  });

  $("appoint").addEventListener("click",()=>{
    const reserve=$("ministerCandidates");
    if(reserve)reserve.scrollIntoView({behavior:"smooth",block:"center"});
    toast("Выберите кандидата из кадрового резерва и изучите его характеристики.");
  });
  $("cancelMinister").addEventListener("click",()=>$("ministerDialog").close());
  $("ministerCandidates").addEventListener("click",event=>{
    const button=event.target.closest("[data-select-minister-candidate]");if(!button||busy)return;
    const candidate=(currentPayload&&currentPayload.ministers||[]).find(item=>item.id===button.dataset.selectMinisterCandidate&&item.is_candidate);
    if(!candidate)return;
    openMinisterAssignment(candidate);
  });
  $("ministerForm").addEventListener("submit",async event=>{
    event.preventDefault();
    const candidateId=$("ministerCandidateId").value,portfolio=$("ministerPortfolio").value;
    if(!candidateId)return toast("Сначала выберите кандидата.");
    try{
      await withBusy(event.submitter,()=>api()("/api/presidential/game/minister",{method:"POST",body:JSON.stringify({action:"appoint",candidateId,portfolio})}),"Кандидат назначен на выбранный мандат.");
      $("ministerDialog").close();selectedMinisterCandidate=null;
    }catch(_){}
  });
  $("ministers").addEventListener("click",async event=>{
    const button=event.target.closest("[data-dismiss-minister]");if(!button||busy)return;
    const name=button.dataset.ministerName||"этого министра";
    if(!confirm("Отправить в отставку: "+name+"?"))return;
    try{await withBusy(button,()=>api()("/api/presidential/game/minister",{method:"POST",body:JSON.stringify({action:"dismiss",ministerId:button.dataset.dismissMinister})}),name+" отправлен в отставку.");}catch(_){}
  });

  $("militaryServiceLaw").addEventListener("change",()=>{});
  $("saveMilitaryService").addEventListener("click",()=>runMilitaryAction({action:"service_law",service:$("militaryServiceLaw").value},$("saveMilitaryService"),"Закон о военной службе утверждён."));
  $("saveMilitaryContracts").addEventListener("click",()=>runMilitaryAction({action:"contract_terms",salaryIndex:Number($("militaryContractSalary").value)},$("saveMilitaryContracts"),"Обновлены условия контрактной службы."));
  $("militaryContractSalary").addEventListener("input",()=>setText("militarySalaryValue",Number($("militaryContractSalary").value).toFixed(2).replace(".",",")+"×"));
  $("militaryBudgetShare").addEventListener("input",()=>setText("militaryBudgetValue",Number($("militaryBudgetShare").value).toFixed(1).replace(".",",")+"%"));
  $("militaryResearchShare").addEventListener("input",()=>setText("militaryResearchShareValue",Number($("militaryResearchShare").value)+"%"));
  $("saveMilitaryBudget").addEventListener("click",()=>runMilitaryAction({
    action:"budget",shareOfGdp:Number($("militaryBudgetShare").value),researchShare:Number($("militaryResearchShare").value)/100
  },$("saveMilitaryBudget"),"Военный бюджет и доля исследований обновлены."));
  $("startMilitaryResearch").addEventListener("click",()=>runMilitaryAction({action:"research",techId:$("militaryResearchSelect").value},$("startMilitaryResearch"),"Новое направление стало приоритетом военных исследований."));
  $("mobilizeMilitaryReserve").addEventListener("click",()=>{
    const amount=Number($("militaryMobilizeCount").value||0);
    if(!Number.isFinite(amount)||amount<1)return toast("Укажите численность резервистов для мобилизации.");
    if(!confirm("Призвать до "+number(amount,0)+" подготовленных резервистов? Это решение повлияет на общество и рынок труда."))return;
    runMilitaryAction({action:"mobilize",personnel:amount},$("mobilizeMilitaryReserve"),"Распоряжение о мобилизации исполнено в пределах закона и доступного резерва.");
  });
  $("defense").addEventListener("click",event=>{
    const program=event.target.closest("[data-military-program]");
    if(program&&!busy){
      const labels={modernization:"модернизацию армии",reserve_training:"подготовку резерва",contract_recruitment:"развитие контрактной службы"};
      if(!confirm("Запустить государственную программу: "+(labels[program.dataset.militaryProgram]||"военную программу")+"? Она потребует первоначального и ежемесячного финансирования."))return;
      runMilitaryAction({action:"start_program",programId:program.dataset.militaryProgram},program,"Государственная военная программа запущена.");
      return;
    }
    const cancelProgram=event.target.closest("[data-cancel-military-program]");
    if(cancelProgram&&!busy){
      if(!confirm("Остановить эту военную государственную программу? Уже потраченные средства не возвращаются."))return;
      runMilitaryAction({action:"cancel_program",programId:cancelProgram.dataset.cancelMilitaryProgram},cancelProgram,"Военная программа остановлена.");
      return;
    }
    const pausePatrol=event.target.closest("[data-pause-patrol]");
    if(pausePatrol&&!busy)runMilitaryAction({action:"cancel_patrol",patrolId:pausePatrol.dataset.pausePatrol},pausePatrol,"Патрульный маршрут приостановлен.");
  });
  $("startMilitaryWar").addEventListener("click",()=>{
    const opponentCountryId=Number($("warOpponentSelect").value),warGoal=$("warGoalInput").value.trim();
    if(!opponentCountryId)return toast("Выберите государство-противника.");
    if(!confirm("Начать военный конфликт? После подтверждения штаб ИИ начнёт оперативные действия, пока вы не измените режим управления."))return;
    runMilitaryAction({action:"start_war",opponentCountryId,warGoal},$("startMilitaryWar"),"Военный конфликт начат. Управление передано штабу ИИ.");
  });
  $("saveMilitaryDirective").addEventListener("click",()=>{
    const war=(currentPayload&&currentPayload.wars||[]).find(item=>item.status==="active");if(!war)return;
    runMilitaryAction({
      action:"war_command",warId:war.id,commandMode:$("militaryCommandMode").value,
      posture:$("militaryPosture").value,directive:$("militaryAiDirective").value.trim()
    },$("saveMilitaryDirective"),"Президентский приказ передан военному штабу.");
  });
  $("advanceMilitaryWar").addEventListener("click",()=>{
    const war=(currentPayload&&currentPayload.wars||[]).find(item=>item.status==="active");if(!war)return;
    if(!confirm(war.command_mode==="ai"?"Запросить следующий оперативный ход штаба ИИ?":"Выполнить оперативный ход по вашим приказам?"))return;
    runMilitaryAction({action:"advance_war_turn",warId:war.id},$("advanceMilitaryWar"),"Оперативный ход завершён. Сводка обновлена.");
  });
  $("ceaseMilitaryWar").addEventListener("click",()=>{
    const war=(currentPayload&&currentPayload.wars||[]).find(item=>item.status==="active");if(!war)return;
    if(!confirm("Запросить прекращение огня и завершить активную фазу конфликта?"))return;
    runMilitaryAction({action:"ceasefire",warId:war.id},$("ceaseMilitaryWar"),"Активные боевые действия прекращены.");
  });
  $("militaryMapMode").addEventListener("change",()=>{
    militaryMapState.mode=$("militaryMapMode").value;
    if(militaryMapState.mode==="patrol"){
      militaryMapState.draft=[];
      setText("militaryMapDraftStatus","Отметьте на карте от двух до восьми точек патрульного маршрута.");
      $("saveMilitaryPatrol").disabled=true;
    }else if(militaryMapState.mode==="order"){
      setText("militaryMapDraftStatus","Выберите подразделение и отметьте целевую точку приказа.");
    }else setText("militaryMapDraftStatus","Режим обзора: карта не принимает приказы.");
  });
  $("saveMilitaryPatrol").addEventListener("click",()=>{
    if(militaryMapState.draft.length<2)return toast("Для маршрута нужно отметить минимум две точки.");
    const unitId=$("militaryMapUnit").value;
    if(!unitId)return toast("Выберите подразделение для патруля.");
    runMilitaryAction({
      action:"create_patrol",unitId,name:$("militaryPatrolName").value.trim(),
      patrolType:$("militaryPatrolType").value,route:militaryMapState.draft
    },$("saveMilitaryPatrol"),"Патрульный маршрут сохранён.");
    militaryMapState.draft=[];
    militaryMapState.mode="view";$("militaryMapMode").value="view";
    $("saveMilitaryPatrol").disabled=true;
  });
  $("clearMilitaryMapDraft").addEventListener("click",()=>{
    militaryMapState.draft=[];setText("militaryMapDraftStatus","Точки карты очищены.");
    $("saveMilitaryPatrol").disabled=true;
    if(currentPayload)renderMilitaryMap(currentPayload);
  });
  $("militaryZoomIn").addEventListener("click",()=>changeMilitaryMapZoom(1.2));
  $("militaryZoomOut").addEventListener("click",()=>changeMilitaryMapZoom(1/1.2));
  $("militaryZoomReset").addEventListener("click",resetMilitaryMapView);
  $("decreeHistory").addEventListener("click",event=>{
    const button=event.target.closest("[data-open-decree]");if(!button)return;
    const decree=decreeCache.get(String(button.dataset.openDecree));if(!decree)return;
    draftId=null;
    fillOfficialDocument(decree,true);
    $("decreeDialog").showModal();
  });
  $("openDecree").addEventListener("click",()=>{
    const savedDraft=getSavedDecreeDraft();
    if(savedDraft&&!forceNewDecreeForProgram){draftId=savedDraft.id;fillOfficialDocument(savedDraft,false);$("decreeDialog").showModal();return;}
    forceNewDecreeForProgram=false;
    $("decreePreview").classList.add("hidden");$("generate").classList.remove("hidden");
    $("decreePreview").dataset.archived="false";
    $("decreeForm").reset();bindLocalDraft($("order"),"order");
    const label=$("decreeForm").querySelector('label[for="order"]');
    if(label)label.classList.remove("hidden");
    $("order").classList.remove("hidden");
    const title=$("decreeForm").querySelector("h3");
    if(title)title.textContent="Подготовить президентский указ";
    const intro=$("decreeForm").querySelector("p");
    if(intro)intro.textContent="Опишите инициативу. Сервер подготовит проект указа с финансовыми условиями и сроком исполнения.";
    $("publishDecree").classList.remove("hidden");
    $("decreeDialog").showModal();
  });
  $("closeDecree").addEventListener("click",()=>$("decreeDialog").close());
  $("closeDecreeTop").addEventListener("click",()=>$("decreeDialog").close());
  bindLocalDraft($("order"),"order");
  $("decreeForm").addEventListener("submit",event=>{
    event.preventDefault();const order=$("order").value.trim();
    if(order.length<10)return toast("Опишите инициативу подробнее.");
    try{
      enqueueBackgroundTask({kind:"decree-draft",route:"/api/presidential/ai/decree/draft",payload:{order}});
      $("order").value="";clearLocalDraft("order");
    }catch(error){toast(error.message);}
  });
  $("publishDecree").addEventListener("click",()=>{
    if(!draftId||busy)return;
    if(!confirm("Опубликовать указ? Он создаст финансируемую программу, а показатели будут изменяться постепенно в течение срока исполнения."))return;
    try{
      enqueueBackgroundTask({kind:"decree-publish",route:"/api/presidential/ai/decree/publish",payload:{decreeId:draftId}});
    }catch(error){toast(error.message);}
  });
  $("copy").addEventListener("click",async()=>{
    try{await navigator.clipboard.writeText($("docTitle").textContent+"\n\n"+$("docBody").textContent);toast("Текст указа скопирован.");}
    catch(_){toast("Копирование недоступно в этом браузере.");}
  });
  $("printDecree").addEventListener("click",()=>window.print());

  async function onPresidentialAuthReady(){
    initializeOutbox();attachStaticLocalDrafts();
    await refreshGame();void startBackgroundQueue();
  }
  window.addEventListener("online",retryFailedBackgroundJobs);
  window.addEventListener("presidential-auth-ready",onPresidentialAuthReady);
  if(window.PRESIDENTIAL_AUTH&&window.PRESIDENTIAL_AUTH.user)onPresidentialAuthReady();
})();