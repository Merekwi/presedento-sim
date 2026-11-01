(()=>{
  "use strict";
  const $=id=>document.getElementById(id);
  let currentPayload=null,currentGame=null,busy=false,refreshInFlight=false;
  let worldMapPromise=null;
  let militaryMapInstance=null,militaryBoundaryLayer=null,militaryFrontLayer=null,militaryUnitLayer=null,militaryPatrolLayer=null,militaryDraftLayer=null;
  let militaryUnitMarkers=new Map();
  let militaryMapState={mode:"view",draft:[],saveKey:"",fitKey:""};
  let selectedMilitaryUnitId="",pendingMilitaryTarget=null,leafletErrorShown=false;
  let clockBaseMs=Date.now(),clockSyncedAt=Date.now(),clockSpeed=1;
  const MILITARY_TECH_LABELS={command:"Командование и связь",logistics:"Военная логистика",air_defense:"ПВО",armor:"Бронетехника",precision:"Высокоточные системы",military_medicine:"Военная медицина",naval:"Военно-морские технологии",cyber_defense:"Кибероборона"};
  const MILITARY_TECH_HINTS={command:"Согласованность штаба и скорость исполнения приказов.",logistics:"Снабжение, ремонт и устойчивость подразделений.",air_defense:"Защита войск, городов и стратегических объектов.",armor:"Защищённость и мобильность сухопутных частей.",precision:"Эффективность операций и снижение потерь.",military_medicine:"Медицинская эвакуация, лечение и восстановление личного состава.",naval:"Готовность флота и безопасность морских коммуникаций.",cyber_defense:"Устойчивость военных сетей и критической инфраструктуры."};
  function node(tag,cls,content){
    const el=document.createElement(tag);if(cls)el.className=cls;
    if(content!==undefined&&content!==null)el.textContent=String(content);return el;
  }
  function setText(id,value){const el=$(id);if(el)el.textContent=value===undefined||value===null?"—":String(value);}
  function number(value,digits=1){return Number(value||0).toLocaleString("ru-RU",{maximumFractionDigits:digits});}
  function money(value){const n=Number(value||0);return Math.abs(n)>=1000?number(n/1000,2)+" трлн $":number(n,2)+" млрд $";}
  function clamp(value,min=0,max=100){return Math.max(min,Math.min(max,Number(value||0)));}
  let toastTimer=null;
  function toast(message){
    const root=$("toast");if(!root)return;root.textContent=message;root.classList.remove("hidden");
    clearTimeout(toastTimer);toastTimer=setTimeout(()=>root.classList.add("hidden"),4500);
  }
  function appAssetUrl(path){
    const script=Array.from(document.scripts).find(item=>/\/military\.js(?:[?#]|$)/i.test(item.src||""));
    return new URL(path,script&&script.src?script.src:window.location.href).href;
  }
  function loadWorldGeoJSON(){
    if(!worldMapPromise){
      worldMapPromise=fetch(appAssetUrl("./assets/world-countries.geojson"),{cache:"no-cache"})
        .then(response=>{if(!response.ok)throw new Error("HTTP "+response.status);return response.json();})
        .then(data=>{if(!data||!Array.isArray(data.features)||!data.features.length)throw new Error("Некорректный GeoJSON");return data;})
        .catch(error=>{worldMapPromise=null;throw new Error("Не удалось загрузить границы государств: "+error.message);});
    }
    return worldMapPromise;
  }
  function renderMapLoading(message){const root=$("militaryMap");if(root)root.replaceChildren(node("div","map-loading",message));}
  function isoCode(feature){
    const p=feature&&feature.properties||{};
    const candidates=[p.ISO_A2_EH,p.ISO_A2,p.POSTAL,p.ADM0_A3];
    return String(candidates.find(value=>value&&value!=="-99")||"").toUpperCase();
  }
  function featureAnchor(feature){
    const p=feature&&feature.properties||{};
    const lat=Number(p.LABEL_Y),lon=Number(p.LABEL_X);
    return Number.isFinite(lat)&&Number.isFinite(lon)?[lat,lon]:null;
  }
  function initMilitaryMap(){
    if(militaryMapInstance)return militaryMapInstance;
    if(!window.L)throw new Error("Не загрузилась библиотека интерактивной карты. Проверьте доступ к CDN и обновите страницу.");
    const map=L.map("militaryMap",{center:[25,10],zoom:2,minZoom:2,maxZoom:18,zoomControl:true,worldCopyJump:true,preferCanvas:true,scrollWheelZoom:true});
    const satellite=L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{
      maxZoom:19,attribution:"Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community"
    });
    const streets=L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",{
      maxZoom:19,attribution:"Map data © Esri and contributors"
    });
    const topo=L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",{
      maxZoom:19,attribution:"Map data © Esri and contributors"
    });
    const labels=L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",{
      maxZoom:19,opacity:.95,attribution:"Place names and boundaries © Esri"
    });
    satellite.addTo(map);labels.addTo(map);
    L.control.layers({"Спутник":satellite,"Улицы":streets,"Топографическая":topo},{"Подписи и названия":labels},{collapsed:false,position:"topright"}).addTo(map);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    militaryBoundaryLayer=L.layerGroup().addTo(map);
    militaryFrontLayer=L.layerGroup().addTo(map);
    militaryPatrolLayer=L.layerGroup().addTo(map);
    militaryUnitLayer=L.layerGroup().addTo(map);
    militaryDraftLayer=L.layerGroup().addTo(map);
    map.on("click",handleMilitaryMapClick);
    map.on("baselayerchange",event=>setText("militaryMapLayerStatus","Подложка: "+event.name));
    militaryMapInstance=map;
    return map;
  }
  function branchInfo(branch){
    return ({land:{label:"Сухопутные",symbol:"⌖",className:"land"},guard:{label:"Гвардия",symbol:"✚",className:"guard"},air:{label:"Авиация",symbol:"✈",className:"air"},naval:{label:"Флот",symbol:"⚓",className:"naval"},hq:{label:"Штаб",symbol:"✥",className:"hq"}})[String(branch||"land").toLowerCase()]||{label:"Подразделение",symbol:"⌖",className:"land"};
  }
  function unitById(id){
    const units=currentPayload&&Array.isArray(currentPayload.units)?currentPayload.units:[];
    return units.find(unit=>String(unit.id)===String(id))||null;
  }
  function selectedUnit(){
    const units=currentPayload&&Array.isArray(currentPayload.units)?currentPayload.units:[];
    return unitById(selectedMilitaryUnitId)||units[0]||null;
  }
  function selectMilitaryUnit(id){
    selectedMilitaryUnitId=String(id||"");
    const select=$("militaryMapUnit");
    if(select)select.value=selectedMilitaryUnitId;
    const unit=selectedUnit();
    setText("militarySelectedUnitName",unit?unit.unit_type||"Воинское подразделение":"Подразделение не выбрано");
    setText("militarySelectedUnitBranch",unit?branchInfo(unit.unit_branch).label:"—");
    setText("militarySelectedUnitPersonnel",unit?number(unit.active_personnel||0,0)+" военнослужащих": "—");
    setText("militarySelectedUnitReadiness",unit?number(unit.readiness||0,0)+"%":"—");
    const location=unit&&unit.location_lat!=null&&unit.location_lon!=null
      ?Number(unit.location_lat).toFixed(3)+", "+Number(unit.location_lon).toFixed(3)
      :"координаты базирования не указаны";
    setText("militarySelectedUnitLocation",location);
    document.querySelectorAll("[data-select-military-unit]").forEach(button=>{
      const active=String(button.dataset.selectMilitaryUnit)===selectedMilitaryUnitId;
      button.classList.toggle("is-selected",active);
      button.setAttribute("aria-pressed",String(active));
    });
    if(militaryMapInstance&&unit&&unit.location_lat!=null&&unit.location_lon!=null){
      militaryMapInstance.panTo([Number(unit.location_lat),Number(unit.location_lon)],{animate:true});
      const marker=militaryUnitMarkers.get(String(unit.id));if(marker)marker.openPopup();
    }
    return unit;
  }
  function countryFeature(data,iso){
    return data.features.find(feature=>isoCode(feature)===String(iso||"").toUpperCase())||null;
  }
  function outerRings(feature){
    const geometry=feature&&feature.geometry;if(!geometry)return [];
    const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.type==="MultiPolygon"?geometry.coordinates:[];
    return polygons.flatMap(polygon=>(polygon||[]).slice(0,1));
  }
  function sharedFrontSegments(homeFeature,enemyFeature){
    const keyFor=(a,b)=>{
      const p=Number(a[0]).toFixed(3)+","+Number(a[1]).toFixed(3);
      const q=Number(b[0]).toFixed(3)+","+Number(b[1]).toFixed(3);
      return p<q?p+"|"+q:q+"|"+p;
    };
    const own=new Map();
    outerRings(homeFeature).forEach(ring=>{
      for(let i=0;i<ring.length-1;i++)own.set(keyFor(ring[i],ring[i+1]),[ring[i],ring[i+1]]);
    });
    const shared=[];
    outerRings(enemyFeature).forEach(ring=>{
      for(let i=0;i<ring.length-1;i++){
        const key=keyFor(ring[i],ring[i+1]),segment=own.get(key);
        if(segment)shared.push(segment.map(point=>[Number(point[1]),Number(point[0])])); 
      }
    });
    return shared;
  }
  function makeUnitIcon(unit,selected){
    const branch=branchInfo(unit.unit_branch),label=branch.symbol;
    return L.divIcon({className:"military-unit-marker-wrap",html:'<span class="military-unit-marker '+branch.className+(selected?" is-selected":"")+'">'+label+'</span>',iconSize:[34,34],iconAnchor:[17,17]});
  }
  function fitMilitaryTheatre(homeFeature,enemyFeature,fitKey){
    if(!militaryMapInstance||militaryMapState.fitKey===fitKey)return;
    militaryMapState.fitKey=fitKey;
    const homeLayer=homeFeature&&L.geoJSON(homeFeature),enemyLayer=enemyFeature&&L.geoJSON(enemyFeature);
    const homeBounds=homeLayer&&homeLayer.getBounds(),enemyBounds=enemyLayer&&enemyLayer.getBounds();
    if(homeBounds&&homeBounds.isValid()&&enemyBounds&&enemyBounds.isValid()){
      const bounds=L.latLngBounds(homeBounds);bounds.extend(enemyBounds);
      militaryMapInstance.fitBounds(bounds.pad(.14),{padding:[42,42],maxZoom:7});
    }else if(homeBounds&&homeBounds.isValid()){
      militaryMapInstance.fitBounds(homeBounds.pad(.12),{padding:[35,35],maxZoom:7});
    }else militaryMapInstance.setView([20,0],2);
  }
  function renderMilitaryMap(payload){
    const root=$("militaryMap");if(!root)return;
    try{
      const map=initMilitaryMap();
      loadWorldGeoJSON().then(data=>{
        if(!root.isConnected)return;
        const game=payload.game||{},war=(payload.wars||[]).find(item=>item.status==="active")||null;
        const homeIso=String(game.iso2||"").toUpperCase();
        const enemyIso=String(war&&(war.opponent_iso2||war.front_state&&war.front_state.enemyCountryIso2)||"").toUpperCase();
        const homeFeature=countryFeature(data,homeIso),enemyFeature=countryFeature(data,enemyIso);
        militaryBoundaryLayer.clearLayers();militaryFrontLayer.clearLayers();militaryUnitLayer.clearLayers();militaryPatrolLayer.clearLayers();militaryDraftLayer.clearLayers();militaryUnitMarkers.clear();
        const boundaries=L.geoJSON(data,{style:feature=>{
          const code=isoCode(feature),isHome=code===homeIso,isEnemy=Boolean(enemyIso)&&code===enemyIso;
          return {color:isHome?"#70f0c0":isEnemy?"#ff8c79":"#dce7eb",weight:isHome?2.8:isEnemy?2.4:.7,opacity:isHome||isEnemy?1:.48,fillColor:isHome?"#16b99a":isEnemy?"#e35e54":"#ffffff",fillOpacity:isHome?.19:isEnemy?.13:0,lineJoin:"round"};
        },onEachFeature:(feature,layer)=>{
          const p=feature.properties||{},name=p.NAME_RU||p.NAME_EN||p.ADMIN||"Государство";
          if(isoCode(feature)===homeIso||isoCode(feature)===enemyIso)layer.bindTooltip(name,{sticky:true,direction:"auto",className:"military-country-tooltip"});
        }});
        boundaries.addTo(militaryBoundaryLayer);
        if(war&&homeFeature&&enemyFeature){
          const segments=sharedFrontSegments(homeFeature,enemyFeature);
          if(segments.length){
            segments.forEach(segment=>L.polyline(segment,{color:"#ff6c59",weight:5,opacity:.96,dashArray:"8 4",lineCap:"round"}).bindTooltip("Граница государств — условная линия соприкосновения",{sticky:true}).addTo(militaryFrontLayer));
          }else{
            const a=featureAnchor(homeFeature),b=featureAnchor(enemyFeature);
            if(a&&b)L.polyline([a,b],{color:"#ffc36b",weight:3,opacity:.9,dashArray:"4 9"}).bindTooltip("Схематичное направление театра конфликта, не фактическая линия фронта").addTo(militaryFrontLayer);
          }
        }
        if(war){
          const enemyAnchor=enemyFeature&&featureAnchor(enemyFeature);
          if(enemyAnchor)L.circleMarker(enemyAnchor,{radius:7,color:"#ffe1d5",weight:2,fillColor:"#c64d43",fillOpacity:1}).bindTooltip("Государство-противник · "+(war.opponent_country_name||"противник")).addTo(militaryFrontLayer);
        }
        const units=Array.isArray(payload.units)?payload.units:[];
        const noCoordinates=[];
        units.forEach(unit=>{
          if(unit.location_lat==null||unit.location_lon==null||!Number.isFinite(Number(unit.location_lat))||!Number.isFinite(Number(unit.location_lon))){noCoordinates.push(unit);return;}
          const branch=branchInfo(unit.unit_branch),marker=L.marker([Number(unit.location_lat),Number(unit.location_lon)],{icon:makeUnitIcon(unit,String(unit.id)===selectedMilitaryUnitId),keyboard:true,title:unit.unit_type||branch.label});
          const popup=node("div","military-marker-popup");
          popup.append(node("b","",unit.unit_type||"Воинское подразделение"));
          popup.append(node("span","",branch.label+" · "+number(unit.active_personnel||0,0)+" чел."));
          popup.append(node("span","","Готовность: "+number(unit.readiness||0,0)+"% · Снабжение: "+number(unit.supply||0,0)+"%"));
          const choose=node("button","military-marker-select","Выбрать соединение");choose.type="button";choose.addEventListener("click",()=>selectMilitaryUnit(unit.id));popup.append(choose);
          marker.bindPopup(popup);marker.on("click",()=>selectMilitaryUnit(unit.id));marker.addTo(militaryUnitLayer);militaryUnitMarkers.set(String(unit.id),marker);
        });
        setText("militaryMapMissingCoordinates",noCoordinates.length?"Без координат базирования: "+noCoordinates.length+" подразделений":"Координаты всех соединений указаны");
        (payload.patrols||[]).filter(item=>item.status==="active").forEach(patrol=>{
          const route=Array.isArray(patrol.route)?patrol.route:[];
          if(route.length<2)return;
          const points=route.map(point=>[Number(point.lat),Number(point.lon)]).filter(point=>point.every(Number.isFinite));
          if(points.length>=2)L.polyline(points,{color:"#ffc85f",weight:3,dashArray:"7 6",opacity:.95}).bindTooltip((patrol.patrol_name||"Патруль")+" · "+(patrol.unit_type||"подразделение")).addTo(militaryPatrolLayer);
          points.forEach((point,index)=>L.circleMarker(point,{radius:4,color:"#24354a",weight:1,fillColor:"#ffd36c",fillOpacity:1}).bindTooltip("Точка "+(index+1)).addTo(militaryPatrolLayer));
        });
        if(militaryMapState.draft.length){
          const points=militaryMapState.draft.map(point=>[point.lat,point.lon]);
          if(militaryMapState.mode==="patrol"&&points.length>1)L.polyline(points,{color:"#ffd36c",weight:4,dashArray:"6 5"}).addTo(militaryDraftLayer);
          points.forEach((point,index)=>L.circleMarker(point,{radius:6,color:"#10263b",weight:2,fillColor:"#ffe08a",fillOpacity:1}).bindTooltip("Точка маршрута "+(index+1)).addTo(militaryDraftLayer));
        }
        if(pendingMilitaryTarget){
          L.circleMarker([pendingMilitaryTarget.lat,pendingMilitaryTarget.lon],{radius:9,color:"#fff",weight:2,fillColor:"#ff6c59",fillOpacity:1}).bindTooltip("Цель приказа · "+pendingMilitaryTarget.lat.toFixed(3)+", "+pendingMilitaryTarget.lon.toFixed(3)).addTo(militaryDraftLayer);
        }
        fitMilitaryTheatre(homeFeature,enemyFeature,String(game.id||"")+":"+(war&&war.id||"peace"));
        setText("militaryMapLayerStatus","Спутниковая подложка · "+(war?"активный театр конфликта":"территория государства"));
        const mode=$("militaryMapMode");if(mode)mode.value=militaryMapState.mode;
        if(militaryMapInstance&&militaryMapInstance.invalidateSize)window.setTimeout(()=>militaryMapInstance&&militaryMapInstance.invalidateSize(),80);
      }).catch(error=>{
        renderMapLoading(error.message||"Не удалось загрузить географические данные.");
        console.error("Military map data failed:",error);
      });
    }catch(error){
      renderMapLoading(error.message||"Не удалось открыть спутниковую карту.");
      if(!leafletErrorShown){leafletErrorShown=true;toast(error.message||"Не удалось загрузить карту.");}
      console.error("Military map init failed:",error);
    }
  }
  function drawMilitaryDraft(){
    if(!militaryMapInstance||!militaryDraftLayer)return;
    militaryDraftLayer.clearLayers();
    const points=militaryMapState.draft.map(point=>[point.lat,point.lon]);
    if(militaryMapState.mode==="patrol"&&points.length>1)L.polyline(points,{color:"#ffd36c",weight:4,dashArray:"6 5"}).addTo(militaryDraftLayer);
    points.forEach((point,index)=>L.circleMarker(point,{radius:6,color:"#10263b",weight:2,fillColor:"#ffe08a",fillOpacity:1}).bindTooltip("Точка маршрута "+(index+1)).addTo(militaryDraftLayer));
    if(pendingMilitaryTarget)L.circleMarker([pendingMilitaryTarget.lat,pendingMilitaryTarget.lon],{radius:9,color:"#fff",weight:2,fillColor:"#ff6c59",fillOpacity:1}).bindTooltip("Цель приказа").addTo(militaryDraftLayer);
  }
  function handleMilitaryMapClick(event){
    const geo={lat:Number(event.latlng.lat),lon:Number(event.latlng.lng)};
    if(militaryMapState.mode==="patrol"){
      if(militaryMapState.draft.length>=8)return toast("В маршруте уже восемь точек.");
      militaryMapState.draft.push(geo);
      setText("militaryMapDraftStatus","Маршрут патруля: "+militaryMapState.draft.length+" точек · добавьте ещё или сохраните.");
      $("saveMilitaryPatrol").disabled=militaryMapState.draft.length<2;
      drawMilitaryDraft();return;
    }
    if(militaryMapState.mode!=="order")return;
    if(!activeWar())return toast("Приказы на театр боевых действий доступны только при активном конфликте.");
    const unit=selectedUnit();if(!unit)return toast("Сначала сформируйте и выберите подразделение.");
    pendingMilitaryTarget=geo;
    setText("militaryTargetPreview","Цель выбрана: "+geo.lat.toFixed(4)+"°, "+geo.lon.toFixed(4)+"°. Теперь проверьте подразделение и приказ.");
    $("confirmMilitaryMapOrder").disabled=false;
    setText("militaryMapDraftStatus","Приказ подготовлен, но ещё не отправлен. Нажмите «Передать приказ».");drawMilitaryDraft();
  }
  function resetMilitaryMapView(){
    if(!militaryMapInstance)return;
    const game=currentPayload&&currentPayload.game||{},war=activeWar();
    const key=String(game.id||"")+":"+(war&&war.id||"peace");
    militaryMapState.fitKey="";
    if(currentPayload)renderMilitaryMap(currentPayload);
    else militaryMapInstance.setView([20,0],2);
    setText("militaryZoomReset","Автомасштаб");
  }
    function activeWar(){return ((currentPayload&&currentPayload.wars)||[]).find(item=>item.status==="active")||null;}
  async function refreshGame(quiet=false){
    const auth=window.PRESIDENTIAL_AUTH;if(refreshInFlight||!auth||!auth.user||!auth.api)return;
    refreshInFlight=true;
    try{
      const result=await auth.api("/api/presidential/game/current");
      if(!result||!result.game){
        currentGame=null;currentPayload=null;renderMapLoading("Активная кампания не найдена. Создайте её в главном штабе.");
        setText("militaryPageStatus","Нет активной кампании");return;
      }
      currentPayload=result;currentGame=result.game;renderPage(result);
    }catch(error){
      setText("militaryPageStatus","Ошибка синхронизации");
      if(!quiet)toast("Не удалось загрузить военную систему: "+(error.message||"ошибка сети"));
      console.error("Military page refresh failed:",error);
    }finally{refreshInFlight=false;}
  }
  async function runMilitaryAction(payload,button,message){
    if(!currentGame||busy)return;
    busy=true;
    document.querySelectorAll(".military-page button").forEach(item=>{item.disabled=true;});
    try{
      await window.PRESIDENTIAL_AUTH.api("/api/presidential/game/military",{method:"POST",body:JSON.stringify(payload)});
      if(payload&&payload.action==="issue_order"){pendingMilitaryTarget=null;setText("militaryTargetPreview","Приказ передан. Ожидается подтверждение штаба.");}
      await refreshGame(true);if(message)toast(message);
    }catch(error){toast("Действие не выполнено: "+(error.message||"ошибка сервера"));}
    finally{
      busy=false;document.querySelectorAll(".military-page button").forEach(item=>{item.disabled=false;});
      if(currentPayload)renderPage(currentPayload);
    }
  }
  function syncClock(game){
    const raw=game&&game.game_datetime;
    const stamp=raw instanceof Date?raw.toISOString():String(raw||"").replace(" ","T");
    const normalized=stamp&&/(Z|[+-]\d{2}:\d{2})$/.test(stamp)?stamp:(stamp?stamp+"Z":"");
    let parsed=normalized?Date.parse(normalized):NaN;
    if(!Number.isFinite(parsed))parsed=Date.parse(String(game&&game.game_date||"")+"T08:00:00Z");
    const speed=Number(game&&game.time_speed||1);clockSpeed=[1,2,4,6,12,16].includes(speed)?speed:1;
    const wallParsed=game&&game.last_simulated_at?Date.parse(String(game.last_simulated_at)):NaN;
    const elapsed=Number.isFinite(wallParsed)?Math.max(0,Math.min(86400000,Date.now()-wallParsed)):0;
    clockBaseMs=(Number.isFinite(parsed)?parsed:Date.now())+elapsed*clockSpeed*60;clockSyncedAt=Date.now();renderClock();
  }
  function renderClock(){
    if(!currentGame)return;
    const current=new Date(clockBaseMs+Math.max(0,Date.now()-clockSyncedAt)*clockSpeed*60);
    if(!Number.isFinite(current.getTime()))return;
    setText("gameClockDate",new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"long",year:"numeric",timeZone:"UTC"}).format(current));
    setText("gameClockTime",new Intl.DateTimeFormat("ru-RU",{hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",timeZone:"UTC"}).format(current));
    document.querySelectorAll("[data-clock-speed]").forEach(button=>{
      const active=Number(button.dataset.clockSpeed)===clockSpeed;button.classList.toggle("is-active",active);button.setAttribute("aria-pressed",String(active));
    });
  }
  function setOptions(select,items,valueField,labelField,emptyLabel){
    if(!select)return;const previous=select.value;select.replaceChildren();
    if(!items.length){const option=node("option","",emptyLabel||"Нет доступных вариантов");option.value="";select.append(option);return;}
    items.forEach(item=>{const option=node("option","",item[labelField]??"—");option.value=String(item[valueField]??"");select.append(option);});
    if(items.some(item=>String(item[valueField])===previous))select.value=previous;
  }
  function renderMilitaryUnits(units){
    const root=$("militaryUnits");root.replaceChildren();
    if(!units.length){root.append(node("div","loading-row","Воинские подразделения ещё не сформированы."));selectMilitaryUnit("");return;}
    if(!units.some(unit=>String(unit.id)===selectedMilitaryUnitId))selectedMilitaryUnitId=String(units[0].id);
    units.forEach(unit=>{
      const branch=branchInfo(unit.unit_branch),amount=branch.className==="air"?number(unit.quantity||0,0)+" единиц техники":branch.className==="naval"?number(unit.quantity||0,0)+" кораблей":number(unit.active_personnel||0,0)+" человек";
      const card=node("article","military-unit-card"+(String(unit.id)===selectedMilitaryUnitId?" is-selected":"")),head=node("div","unit-card-head");
      const identity=node("div","unit-card-identity");identity.append(node("b","",unit.unit_type||"Воинское подразделение"),node("span","unit-branch",branch.label));
      const choose=node("button","unit-select-button",String(unit.id)===selectedMilitaryUnitId?"Выбрано":"Выбрать");choose.type="button";choose.dataset.selectMilitaryUnit=unit.id;choose.setAttribute("aria-pressed",String(String(unit.id)===selectedMilitaryUnitId));
      head.append(identity,choose);
      const stats=node("div","unit-card-stats");
      [["Численность",amount],["Готовность",number(unit.readiness||0,0)+"%"],["Снабжение",number(unit.supply||0,0)+"%"],["Оснащение",number(unit.equipment_level||0,0)+"%"]].forEach(([label,value])=>{
        const item=node("div","unit-stat");item.append(node("small","",label),node("b","",value));stats.append(item);
      });
      card.append(head,stats);
      const location=unit.location_lat!=null&&unit.location_lon!=null
        ?"Координаты: "+Number(unit.location_lat).toFixed(3)+", "+Number(unit.location_lon).toFixed(3)
        :"Место базирования не задано — на карте не отмечается";
      card.append(node("small","unit-location",location));
      root.append(card);
    });
    selectMilitaryUnit(selectedMilitaryUnitId);
  }
    function renderTechnologies(payload){
    const technologies=Array.isArray(payload.technologies)?payload.technologies:[];
    const select=$("militaryResearchSelect"),previous=select.value;select.replaceChildren();
    technologies.forEach(tech=>{
      const option=node("option","",(MILITARY_TECH_LABELS[tech.tech_id]||tech.tech_id)+" · уровень "+Number(tech.level||0));
      option.value=tech.tech_id;select.append(option);
    });
    if(technologies.some(tech=>tech.tech_id===previous))select.value=previous;
    const root=$("militaryTechnologyList");root.replaceChildren();
    if(!technologies.length)root.append(node("div","loading-row","Технологические направления не найдены."));
    technologies.forEach(tech=>{
      const level=Number(tech.level||0),points=Number(tech.research_points||0),target=(level+1)*100,progress=level>=5?100:Math.min(100,points/Math.max(1,target)*100);
      const card=node("article","military-technology-card"),head=node("div","military-technology-head");
      head.append(node("b","",MILITARY_TECH_LABELS[tech.tech_id]||tech.tech_id),node("small","",level>=5?"МАКС. УРОВЕНЬ":"Уровень "+level));
      const track=node("div","military-tech-track"),fill=node("i");fill.style.width=progress+"%";track.append(fill);
      card.append(head,node("p","",MILITARY_TECH_HINTS[tech.tech_id]||"Военно-техническое развитие страны"),track);
      if(tech.is_researching)card.append(node("small","technology-current","Текущий приоритет · "+points+" / "+target+" очков"));
      root.append(card);
    });
  }
  function renderActivePrograms(military){
    const root=$("activeMilitaryPrograms");root.replaceChildren();
    const programs=Array.isArray(military.programs)?military.programs:[],active=programs.filter(item=>item.status==="active");
    if(!active.length)root.append(node("small","military-explainer","Активных военных программ нет."));
    active.forEach(program=>{
      const row=node("div","active-military-program");
      row.append(node("span","",program.title+" · "+program.monthsCompleted+"/"+program.durationMonths+" мес."));
      const cancel=node("button","secondary-button","Остановить");cancel.type="button";cancel.dataset.cancelMilitaryProgram=program.programId;
      row.append(cancel);root.append(row);
    });
  }
  function renderPatrols(patrols){
    const root=$("militaryPatrolList");root.replaceChildren();
    if(!patrols.length){root.append(node("div","loading-row","Патрульные маршруты ещё не созданы."));return;}
    patrols.forEach(patrol=>{
      const row=node("div","military-patrol-row"),info=node("div","");
      info.append(node("b","",patrol.patrol_name||"Патруль"),node("small","",(patrol.unit_type||"Подразделение")+" · "+(patrol.status==="active"?"Активен":"Приостановлен")+" · "+(Array.isArray(patrol.route)?patrol.route.length:0)+" точек"));
      row.append(info);
      if(patrol.status==="active"){const pause=node("button","secondary-button","Пауза");pause.type="button";pause.dataset.pausePatrol=patrol.id;row.append(pause);}
      root.append(row);
    });
  }
  function renderWar(payload){
    const war=activeWar(),noWar=$("militaryNoWar"),active=$("militaryActiveWar");
    noWar.classList.toggle("hidden",Boolean(war));active.classList.toggle("hidden",!war);
    const status=$("militaryWarStatus");status.textContent=war?"ВОЙНА":"МИР";status.classList.toggle("war",Boolean(war));
    const relations=Array.isArray(payload.relations)?payload.relations:[];
    setOptions($("warOpponentSelect"),relations.map(item=>({id:item.other_country_id,name:item.other_country_name})),"id","name","Нет доступных дипломатических контактов");
    $("warOpponentSelect").disabled=Boolean(war);
    if(!war)return;
    const front=war.front_state||{},control=Number(front.territoryControl??50);
    setText("militaryOpponentName",war.opponent_country_name||"Противник");
    setText("militaryFrontValue",control.toFixed(1)+"%");
    $("militaryFrontControl").style.width=clamp(control)+"%";
    setText("militaryFriendlyLosses",number(front.friendlyLosses||0,0));
    setText("militaryEnemyLosses",number(front.enemyLosses||0,0));
    setText("militaryBattleTurn",String(front.battleTurn||war.turn_number||0));
    $("militaryCommandMode").value=war.command_mode||"ai";
    $("militaryPosture").value=war.strategic_posture||"balanced";
    if(document.activeElement!==$("militaryAiDirective"))$("militaryAiDirective").value=war.commander_directive||"";
    const report=war.last_report||{},domains=report.domainControl||front.domainControl||{};
    const lastAuto=report.autoTickAt?new Date(report.autoTickAt).toLocaleString("ru-RU",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):"ожидается первый цикл";
    setText("militaryWarReport",war.command_mode==="ai"
      ?"АВТОНОМНЫЙ ШТАБ · последний цикл: "+lastAuto+". "+(report.aiReason||front.lastAiReason||"Штаб оценивает силы и снабжение.")+" Потери за цикл: "+number(report.friendlyLosses||0,0)+" / "+number(report.enemyLosses||0,0)+". Воздушный контроль: "+number(domains.air||50,1)+"%; морской: "+number(domains.sea||50,1)+"%."
      :"РУЧНОЕ КОМАНДОВАНИЕ · автоматические операции приостановлены. Отдавайте приказы на карте.");
    $("advanceMilitaryWar").classList.toggle("hidden",war.command_mode==="ai");
    const own=report.friendlyDomains||front.friendlyDomains||{},rival=report.enemyDomains||front.estimatedEnemyDomains||{};
    const domain=$("militaryDomainMetrics");domain.replaceChildren();
    [["СУХОПУТНЫЕ",own.ground,rival.ground],["АВИАЦИЯ",own.air,rival.air],["ФЛОТ",own.naval,rival.naval]].forEach(([label,a,b])=>{
      const item=node("div","military-domain-metric");item.append(node("small","",label),node("b","",number(a||0,0)+" / "+number(b||0,0)));domain.append(item);
    });
  }
  function renderMilitaryData(payload){
    const military=payload.military||((payload.game&&payload.game.state)||{}).military||{};
    const manpower=military.manpower||{},contracts=military.contracts||{},budget=military.budget||{};
    setText("militaryActivePersonnel",number(manpower.activePersonnel||0,0));
    setText("militaryReservePersonnel",number(manpower.trainedReserve||0,0));
    setText("militaryAvailablePersonnel",number(manpower.availablePool||0,0));
    setText("militaryApplicants",number(contracts.monthlyApplicants||0,0));
    $("militaryServiceLaw").value=(military.laws&&military.laws.service)||"volunteer";
    $("militaryContractSalary").value=String(Number(contracts.salaryIndex||1));
    setText("militarySalaryValue",Number(contracts.salaryIndex||1).toFixed(2).replace(".",",")+"×");
    $("militaryBudgetShare").value=String(Number(budget.shareOfGdp||1.6));
    setText("militaryBudgetValue",Number(budget.shareOfGdp||1.6).toFixed(1).replace(".",",")+"%");
    $("militaryResearchShare").value=String(Math.round(Number(budget.researchShare||.12)*100));
    setText("militaryResearchShareValue",Math.round(Number(budget.researchShare||.12)*100)+"%");
    renderTechnologies(payload);renderActivePrograms(military);
    renderPatrols(Array.isArray(payload.patrols)?payload.patrols:[]);
    const units=Array.isArray(payload.units)?payload.units:[];
    setOptions($("militaryMapUnit"),units,"id","unit_type","Подразделения пока не созданы");
    if(!units.some(unit=>String(unit.id)===selectedMilitaryUnitId))selectedMilitaryUnitId=units.length?String(units[0].id):"";
    renderMilitaryUnits(units);renderWar(payload);renderMilitaryMap(payload);
  }
  function renderPage(payload){
    const game=payload.game||{};
    setText("militaryPageCountry",game.name_local||game.name_en||game.save_name||"Государство");
    setText("militaryPageFlag",game.flag_emoji||"🏳️");
    setText("militaryPageRegion",(game.region||"")+(game.government_type?" · "+game.government_type:""));
    setText("militaryPageStatus","Сохранение синхронизировано");
    setText("militaryPagePresident",game.president_name||"Президент");
    syncClock(game);renderMilitaryData(payload);
  }
  function bindActions(){
    document.querySelectorAll("[data-clock-speed]").forEach(button=>button.addEventListener("click",async()=>{
      const speed=Number(button.dataset.clockSpeed);
      if(![1,2,4,6,12,16].includes(speed)||speed===clockSpeed||busy)return;
      try{await window.PRESIDENTIAL_AUTH.api("/api/presidential/game/clock",{method:"POST",body:JSON.stringify({speed})});await refreshGame(true);}
      catch(error){toast("Не удалось изменить скорость времени: "+error.message);}
    }));
    $("militaryZoomIn").addEventListener("click",()=>{if(militaryMapInstance)militaryMapInstance.zoomIn();});
    $("militaryZoomOut").addEventListener("click",()=>{if(militaryMapInstance)militaryMapInstance.zoomOut();});
    $("militaryZoomReset").addEventListener("click",resetMilitaryMapView);
    $("militaryMapUnit").addEventListener("change",()=>selectMilitaryUnit($("militaryMapUnit").value));
    $("militaryMapMode").addEventListener("change",()=>{
      militaryMapState.mode=$("militaryMapMode").value;
      militaryMapState.draft=[];pendingMilitaryTarget=null;
      $("saveMilitaryPatrol").disabled=true;$("confirmMilitaryMapOrder").disabled=true;
      if(militaryMapState.mode==="patrol")setText("militaryMapDraftStatus","Патруль: последовательно отметьте на карте от двух до восьми точек.");
      else if(militaryMapState.mode==="order")setText("militaryMapDraftStatus","Приказ: выберите соединение и отметьте цель на спутниковой карте.");
      else setText("militaryMapDraftStatus","Обзор: перемещайте карту, приближайте районы и выбирайте соединения.");
      setText("militaryTargetPreview","Цель ещё не выбрана.");drawMilitaryDraft();
    });
    $("confirmMilitaryMapOrder").addEventListener("click",()=>{
      const war=activeWar(),unit=selectedUnit(),target=pendingMilitaryTarget,orderType=$("militaryMapOrder").value;
      if(!war)return toast("Нет активного конфликта.");
      if(!unit)return toast("Выберите подразделение.");
      if(!target)return toast("Сначала отметьте цель на карте.");
      const labels={advance:"движение к указанному району",defend:"оборона указанного района",hold:"удержание позиции",recon:"разведка района",withdraw:"отход на указанный рубеж",support:"поддержка соседних частей"};
      if(!confirm("Передать приказ: "+(labels[orderType]||orderType)+"?\\nПодразделение: "+(unit.unit_type||"часть")+"\\nКоординаты: "+target.lat.toFixed(4)+", "+target.lon.toFixed(4)))return;
      const objective=labels[orderType]||"Выполнить приказ в отмеченной точке";
      void runMilitaryAction({action:"issue_order",warId:war.id,unitId:unit.id,orderType,targetLat:target.lat,targetLon:target.lon,objective},$("confirmMilitaryMapOrder"),"Приказ передан в систему командования.");
    });
    $("saveMilitaryPatrol").addEventListener("click",()=>{
      if(militaryMapState.draft.length<2)return toast("Для патруля нужно отметить минимум две точки.");
      const unit=selectedUnit();if(!unit)return toast("Выберите подразделение для патруля.");
      const route=militaryMapState.draft.slice();
      if(!confirm("Сохранить маршрут «"+$("militaryPatrolName").value.trim()+"» для "+(unit.unit_type||"подразделения")+"?"))return;
      void runMilitaryAction({action:"create_patrol",unitId:unit.id,name:$("militaryPatrolName").value.trim(),patrolType:$("militaryPatrolType").value,route},$("saveMilitaryPatrol"),"Патрульный маршрут сохранён.");
      militaryMapState.draft=[];militaryMapState.mode="view";$("militaryMapMode").value="view";$("saveMilitaryPatrol").disabled=true;drawMilitaryDraft();
    });
    $("clearMilitaryMapDraft").addEventListener("click",()=>{
      militaryMapState.draft=[];pendingMilitaryTarget=null;
      setText("militaryMapDraftStatus","Черновик очищен. Ни один приказ не отправлен.");
      setText("militaryTargetPreview","Цель ещё не выбрана.");
      $("saveMilitaryPatrol").disabled=true;$("confirmMilitaryMapOrder").disabled=true;drawMilitaryDraft();
    });
    $("militaryUnits").addEventListener("click",event=>{
      const button=event.target.closest("[data-select-military-unit]");
      if(!button)return;
      selectMilitaryUnit(button.dataset.selectMilitaryUnit);
      setText("militaryMapDraftStatus","Выбрано соединение: "+(selectedUnit()?.unit_type||"подразделение")+". Перейдите в режим приказа, чтобы указать цель.");
    });
    $("startMilitaryWar").addEventListener("click",()=>{
      const opponentCountryId=Number($("warOpponentSelect").value),warGoal=$("warGoalInput").value.trim();
      if(!opponentCountryId)return toast("Выберите государство-противника.");
      if(!confirm("Начать военный конфликт? После подтверждения штаб ИИ начнёт оперативные действия."))return;
      void runMilitaryAction({action:"start_war",opponentCountryId,warGoal},$("startMilitaryWar"),"Военный конфликт начат. Управление передано штабу ИИ.");
    });
    $("saveMilitaryDirective").addEventListener("click",()=>{
      const war=activeWar();if(!war)return;
      void runMilitaryAction({action:"war_command",warId:war.id,commandMode:$("militaryCommandMode").value,posture:$("militaryPosture").value,directive:$("militaryAiDirective").value.trim()},$("saveMilitaryDirective"),"Президентский приказ передан военному штабу.");
    });
    $("advanceMilitaryWar").addEventListener("click",()=>{
      const war=activeWar();if(!war)return;
      if(!confirm("Выполнить следующий оперативный ход по вашим приказам?"))return;
      void runMilitaryAction({action:"advance_war_turn",warId:war.id},$("advanceMilitaryWar"),"Оперативный ход завершён. Сводка обновлена.");
    });
    $("ceaseMilitaryWar").addEventListener("click",()=>{
      const war=activeWar();if(!war)return;
      if(!confirm("Запросить прекращение огня и завершить активную фазу конфликта?"))return;
      void runMilitaryAction({action:"ceasefire",warId:war.id},$("ceaseMilitaryWar"),"Активные боевые действия прекращены.");
    });
    $("saveMilitaryService").addEventListener("click",()=>void runMilitaryAction({action:"service_law",service:$("militaryServiceLaw").value},$("saveMilitaryService"),"Закон о военной службе утверждён."));
    $("saveMilitaryContracts").addEventListener("click",()=>void runMilitaryAction({action:"contract_terms",salaryIndex:Number($("militaryContractSalary").value)},$("saveMilitaryContracts"),"Обновлены условия контрактной службы."));
    $("militaryContractSalary").addEventListener("input",()=>setText("militarySalaryValue",Number($("militaryContractSalary").value).toFixed(2).replace(".",",")+"×"));
    $("militaryBudgetShare").addEventListener("input",()=>setText("militaryBudgetValue",Number($("militaryBudgetShare").value).toFixed(1).replace(".",",")+"%"));
    $("militaryResearchShare").addEventListener("input",()=>setText("militaryResearchShareValue",Number($("militaryResearchShare").value)+"%"));
    $("saveMilitaryBudget").addEventListener("click",()=>void runMilitaryAction({action:"budget",shareOfGdp:Number($("militaryBudgetShare").value),researchShare:Number($("militaryResearchShare").value)/100},$("saveMilitaryBudget"),"Военный бюджет и доля исследований обновлены."));
    $("startMilitaryResearch").addEventListener("click",()=>void runMilitaryAction({action:"research",techId:$("militaryResearchSelect").value},$("startMilitaryResearch"),"Новое направление стало приоритетом военных исследований."));
    $("mobilizeMilitaryReserve").addEventListener("click",()=>{
      const amount=Number($("militaryMobilizeCount").value||0);
      if(!Number.isFinite(amount)||amount<1)return toast("Укажите численность резервистов для мобилизации.");
      if(!confirm("Призвать до "+number(amount,0)+" подготовленных резервистов? Это решение повлияет на общество и рынок труда."))return;
      void runMilitaryAction({action:"mobilize",personnel:amount},$("mobilizeMilitaryReserve"),"Распоряжение о мобилизации исполнено в пределах закона и доступного резерва.");
    });
    $("militaryControls").addEventListener("click",event=>{
      const program=event.target.closest("[data-military-program]");
      if(program){
        const labels={modernization:"модернизацию армии",reserve_training:"подготовку резерва",contract_recruitment:"развитие контрактной службы"};
        if(!confirm("Запустить государственную программу: "+(labels[program.dataset.militaryProgram]||"военную программу")+"? Она потребует первоначального и ежемесячного финансирования."))return;
        void runMilitaryAction({action:"start_program",programId:program.dataset.militaryProgram},program,"Государственная военная программа запущена.");return;
      }
      const cancel=event.target.closest("[data-cancel-military-program]");
      if(cancel){
        if(!confirm("Остановить эту военную государственную программу? Уже потраченные средства не возвращаются."))return;
        void runMilitaryAction({action:"cancel_program",programId:cancel.dataset.cancelMilitaryProgram},cancel,"Военная программа остановлена.");return;
      }
      const pause=event.target.closest("[data-pause-patrol]");
      if(pause)void runMilitaryAction({action:"cancel_patrol",patrolId:pause.dataset.pausePatrol},pause,"Патрульный маршрут приостановлен.");
    });
  }
  function start(){
    bindActions();
    window.addEventListener("presidential-auth-ready",()=>{void refreshGame();});
    if(window.PRESIDENTIAL_AUTH&&window.PRESIDENTIAL_AUTH.user)void refreshGame();
    window.setInterval(renderClock,1000);
    window.setInterval(()=>{if(!document.hidden&&!busy)void refreshGame(true);},15000);
  }
  start();
})();