(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const api = () => {
    const auth=window.PRESIDENTIAL_AUTH;
    if(!auth||!auth.api)return null;
    return (route,options={})=>{
      if(String(options.method||"GET").toUpperCase()!=="POST")return auth.api(route,options);
      let payload={};
      try{payload=options.body?JSON.parse(options.body):{};}
      catch(_){return Promise.reject(new Error("Не удалось сохранить данные запроса локально."));}
      try{
        const id=enqueueBackgroundTask({kind:"game-request",client:"api",route,payload});
        return Promise.resolve({__backgroundQueued:true,id});
      }catch(error){return Promise.reject(error);}
    };
  };
  let currentPayload = null, currentGame = null, draftId = null, busy = false;
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
      discard=node("button","background-queue-discard","Удалить запросы прошлой кампании");
      discard.type="button";discard.id="backgroundQueueDiscard";
      discard.style.cssText="margin:4px 0 0 6px;padding:3px 7px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#64748b;font-size:11px;cursor:pointer";
      discard.addEventListener("click",discardBlockedBackgroundJobs);host.parentElement.append(discard);
    }
    if(discard){discard.hidden=!failed.some(item=>item.status==="blocked");discard.disabled=outboxRunning;}
    const pending=active.length>0;
    const advance=$("advanceTurn"),newGame=$("newGame"),vote=$("electionVote");
    if(advance&&currentGame)advance.disabled=busy||pending||["election_campaign","election"].includes(currentGame.state&&currentGame.state.phase);
    if(newGame)newGame.disabled=busy||pending;
    if(vote)vote.disabled=busy||pending||vote.classList.contains("hidden")||vote.textContent.includes("Сначала");
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
    const newCampaignQueued=outbox.some(item=>item.status==="queued"&&item.route==="/api/presidential/game/new");
    if(!auth||!auth.api||!auth.aiApi||(!currentGame&&!newCampaignQueued))return;
    outboxRunning=true;updateOutboxIndicator();
    try{
      while(true){
        const item=outbox.find(entry=>entry.status==="queued");
        if(!item)break;
        const saveId=activeSaveId();
        if((item.saveId&&item.saveId!==saveId)||(!currentGame&&item.route!=="/api/presidential/game/new")){
          item.status="blocked";item.error="Кампания уже изменилась или завершилась. Запрос сохранён, но не отправлен в другое сохранение.";
          persistOutbox();continue;
        }
        item.status="sending";item.lastAttemptAt=new Date().toISOString();persistOutbox();
        let result;
        try{
          const request=item.client==="api"?auth.api:auth.aiApi;
          result=await request(item.route,{method:"POST",headers:{"Idempotency-Key":item.id},body:JSON.stringify(item.payload)});
        }catch(error){
          item.status="failed";item.error=error&&error.message?error.message:"Неизвестная ошибка отправки";
          item.failedAt=new Date().toISOString();persistOutbox();
          toast("Запрос сохранён локально, но сервер не ответил: "+item.error);break;
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
    outbox.forEach(item=>{if(item.status==="failed"){item.status="queued";delete item.error;}});
    try{persistOutbox();void startBackgroundQueue();}catch(error){toast(error.message);}
  }
  function discardBlockedBackgroundJobs(){
    if(outboxRunning)return;
    const count=outbox.filter(item=>item.status==="blocked").length;
    if(!count)return;
    if(!confirm("Удалить "+count+" сохранённых запрос(ов), относящихся к предыдущей кампании? Они не будут отправлены."))return;
    outbox=outbox.filter(item=>item.status!=="blocked");
    try{persistOutbox();toast("Устаревшие запросы удалены с этого устройства.");}catch(error){toast(error.message);}
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

  function renderMinisters(items){
    const root=$("ministers");if(!root)return;root.replaceChildren();
    if(!items||!items.length){root.append(node("div","loading-row","Состав правительства не сформирован."));return;}
    items.forEach(minister=>{
      const row=node("div","minister-row"),traits=minister.traits&&typeof minister.traits==="object"?minister.traits:{};
      const avatar=node("div","minister-avatar");avatar.append(portraitNode(traits.portraitId||portraitIdFromName(minister.full_name),"portrait-svg"));
      const info=node("div","minister-info");
      info.append(node("b","",minister.full_name));
      info.append(node("small","",minister.portfolio+" · "+(traits.archetypeLabel||"Специалист")+" · "+minister.age+" лет"));
      info.append(node("small","minister-reliability","Компетентность "+minister.competence+" · Лояльность "+minister.loyalty));
      const effects=node("div","minister-effects");
      const labels={gdpGrowth:"рост ВВП",inflation:"инфляция",unemployment:"безработица",approval:"одобрение",stability:"стабильность",corruption:"коррупция",publicServices:"госуслуги",education:"образование",healthcare:"медицина",infrastructure:"инфраструктура",militaryPower:"армия",budgetBalance:"бюджет"};
      Object.entries(traits.effects||{}).forEach(([key,value])=>{
        if(!labels[key])return;
        const n=Number(value),chip=node("span",n>=0?"effect-positive":"effect-negative",(n>0?"+":"")+n.toFixed(2)+" "+labels[key]);
        effects.append(chip);
      });
      if(effects.childNodes.length)info.append(effects);
      const score=node("div","minister-score","★ "+minister.competence);
      const dismiss=node("button","dismiss-button","×");dismiss.type="button";dismiss.title="Отправить министра в отставку";
      dismiss.dataset.dismissMinister=minister.id;dismiss.dataset.ministerName=minister.full_name;dismiss.disabled=busy;
      row.append(avatar,info,score,dismiss);root.append(row);
    });
    const select=$("ministerPortfolio");
    if(select){
      const occupied=new Set(items.map(item=>item.portfolio));
      Array.from(select.options).forEach(option=>option.disabled=occupied.has(option.value));
      const free=Array.from(select.options).find(option=>!option.disabled);if(free)select.value=free.value;
    }
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
    const support=Number(election.candidateSupport||0),opposition=Math.max(0,100-support);
    const completed=index>=agenda.length&&agenda.length>0;

    setText("electionTitle",election.type||"Национальная избирательная кампания");
    setText("electionRound",election.firstElection?"ПЕРВЫЕ ВЫБОРЫ":"ПЕРЕИЗБРАНИЕ · ТУР "+(election.round||2));
    setText("electionDate",dateLabel(election.scheduledDate||game.game_date));
    setText("electionDescription","Формируйте собственную программу, работайте с избирателями и отслеживайте, как решения меняют отношение разных групп к вашей партии.");
    setText("electionCandidate",game.president_name);
    setText("electionParty",election.partyName||"Ваша политическая партия");
    const photo=$("electionPortrait");
    if(photo)photo.replaceChildren(portraitNode(state.presidentPortrait||"p01"));
    setText("candidateSupport",support.toFixed(1)+"%");
    setText("oppositionSupport",opposition.toFixed(1)+"%");
    const candidateBar=$("candidateSupportBar"),oppositionBar=$("oppositionSupportBar");
    if(candidateBar)candidateBar.style.width=Math.min(100,support)+"%";
    if(oppositionBar)oppositionBar.style.width=Math.min(100,opposition)+"%";
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

      const activeEvent=state.campaignEvent&&state.campaignEvent.status==="active"?state.campaignEvent:null;
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
        groupWrap.append(node("span","","С кем встретиться"));
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
      actionPanel.append(freeform);

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
      vote.disabled=!completed||busy||hasPendingBackgroundJobs();
      vote.textContent=completed?"Провести национальные выборы →":"Сначала завершите программу";
    }
    document.querySelectorAll("[data-election-proposal],[data-election-activity]").forEach(button=>button.disabled=busy);
  }

  function renderProjects(game){
    const root=$("activePrograms");if(!root)return;root.replaceChildren();
    const projects=Array.isArray(game.state&&game.state.projects)?game.state.projects:[],active=projects.filter(item=>item.status==="active");
    if(!active.length)root.append(node("div","programs-empty","Активных проектов нет. Выберите долгосрочную программу ниже."));
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
      button.disabled=busy||exists||active.length>=3||Number((game.state||{}).actionPoints??2)<1;
      button.textContent=exists?"Уже запущена":"Запустить";
    });
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
    $("politicalActionSubmit").disabled=busy;
    $("politicalActionInput").disabled=busy;
  }
  function renderGame(payload){
    if(!payload||!payload.game){currentGame=null;return;}
    currentPayload=payload;currentGame=payload.game;
    renderIdentity(currentGame);renderMetrics(currentGame);renderElection(currentGame);
    renderMinisters(payload.ministers);renderEvents(payload.events);renderRelations(payload.relations);
    renderUnits(payload.units);renderDecrees(payload.decrees);renderProjects(currentGame);renderInstitutions(currentGame);renderPoliticalActionPanel(currentGame);
    setText("saveStatus","Сохранение синхронизировано");
    const advance=$("advanceTurn"),newGame=$("newGame");
    if(advance)advance.disabled=busy||hasPendingBackgroundJobs()||["election_campaign","election"].includes(currentGame.state&&currentGame.state.phase);
    if(newGame)newGame.disabled=busy||hasPendingBackgroundJobs();
  }

  async function refreshGame(){
    if(!api()||!window.PRESIDENTIAL_AUTH||!window.PRESIDENTIAL_AUTH.user)return;
    setText("saveStatus","Синхронизация…");
    try{
      let result=await api()("/api/presidential/game/current");
      if(!result.game){currentGame=null;if(busy)needsSetupAfterBusy=true;else await openSetup();return;}
      const election=result.game.state&&result.game.state.election||{};
      const inElection=["election_campaign","election"].includes(String(result.game.state&&result.game.state.phase||""));
      if(inElection&&Number(election.baselineVersion||0)<2&&window.PRESIDENTIAL_AUTH.aiApi){
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
    }catch(error){toast("Действие не выполнено: "+(error&&error.message?error.message:"ошибка сервера"));throw error;}
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
    link.addEventListener("click",()=>{document.querySelectorAll(".nav-link").forEach(item=>item.classList.remove("active"));link.classList.add("active");});
  });
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

  $("appoint").addEventListener("click",()=>$("ministerDialog").showModal());
  $("cancelMinister").addEventListener("click",()=>$("ministerDialog").close());
  $("ministerForm").addEventListener("submit",async event=>{
    event.preventDefault();
    const payload={
      action:"appoint",name:$("ministerName").value.trim(),portfolio:$("ministerPortfolio").value,
      age:Number($("ministerAge").value),competence:Number($("ministerCompetence").value),
      loyalty:Number($("ministerLoyalty").value),archetype:$("ministerArchetype").value,portraitId:$("ministerPortrait").value
    };
    try{
      await withBusy(event.submitter,()=>api()("/api/presidential/game/minister",{method:"POST",body:JSON.stringify(payload)}),"Министр назначен. Его качества будут влиять на ежемесячные показатели.");
      $("ministerDialog").close();$("ministerForm").reset();$("ministerAge").value=45;$("ministerCompetence").value=70;$("ministerLoyalty").value=65;
    }catch(_){}
  });
  $("ministers").addEventListener("click",async event=>{
    const button=event.target.closest("[data-dismiss-minister]");if(!button||busy)return;
    const name=button.dataset.ministerName||"этого министра";
    if(!confirm("Отправить в отставку: "+name+"?"))return;
    try{await withBusy(button,()=>api()("/api/presidential/game/minister",{method:"POST",body:JSON.stringify({action:"dismiss",ministerId:button.dataset.dismissMinister})}),name+" отправлен в отставку.");}catch(_){}
  });

  $("decreeHistory").addEventListener("click",event=>{
    const button=event.target.closest("[data-open-decree]");if(!button)return;
    const decree=decreeCache.get(String(button.dataset.openDecree));if(!decree)return;
    draftId=null;
    fillOfficialDocument(decree,true);
    $("decreeDialog").showModal();
  });
  $("openDecree").addEventListener("click",()=>{
    const savedDraft=getSavedDecreeDraft();
    if(savedDraft){draftId=savedDraft.id;fillOfficialDocument(savedDraft,false);$("decreeDialog").showModal();return;}
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
  window.addEventListener("presidential-auth-ready",onPresidentialAuthReady);
  if(window.PRESIDENTIAL_AUTH&&window.PRESIDENTIAL_AUTH.user)onPresidentialAuthReady();
})();