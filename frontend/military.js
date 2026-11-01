(()=>{
  "use strict";
  const $=id=>document.getElementById(id);
  let currentPayload=null,currentGame=null,busy=false,refreshInFlight=false;
  let worldMapPromise=null;
  let militaryMapView={scale:1,x:0,y:0};
  let militaryMapLayer=null;
  let militaryMapState={mode:"view",draft:[],justDragged:false,saveKey:""};
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
        .catch(error=>{worldMapPromise=null;throw new Error("Не удалось загрузить локальные географические границы: "+error.message);});
    }
    return worldMapPromise;
  }
  function renderMapLoading(message){const root=$("militaryMap");if(root)root.replaceChildren(node("div","map-loading",message));}

  function mollweidePoint(point,width,height){
    const longitude=Number(point&&point[0]);
    const latitude=clamp(Number(point&&point[1]),-89.999999,89.999999);
    const phi=latitude*Math.PI/180;
    let theta=phi;
    if(Math.abs(Math.abs(phi)-Math.PI/2)<1e-7)theta=Math.sign(phi)*Math.PI/2;
    else{
      for(let i=0;i<14;i++){
        const numerator=2*theta+Math.sin(2*theta)-Math.PI*Math.sin(phi);
        const denominator=2+2*Math.cos(2*theta);
        if(Math.abs(denominator)<1e-9)break;
        const step=numerator/denominator;
        theta-=step;
        if(Math.abs(step)<1e-9)break;
      }
    }
    const x=width*(.5+(longitude*Math.PI/180)*Math.cos(theta)/(2*Math.PI));
    const y=height*(.5-Math.sin(theta)/2);
    return [x,y];
  }
  function geometryPath(geometry,width,height){
    if(!geometry)return "";
    const polygons=geometry.type==="Polygon"?[geometry.coordinates]:
      geometry.type==="MultiPolygon"?geometry.coordinates:[];
    const paths=[];
    polygons.forEach(polygon=>{
      (polygon||[]).forEach(ring=>{
        if(!Array.isArray(ring)||ring.length<3)return;
        let path="",previousX=null;
        ring.forEach((coordinate,index)=>{
          const point=mollweidePoint(coordinate,width,height);
          let x=point[0];
          if(previousX!==null){
            while(x-previousX>width/2)x-=width;
            while(x-previousX< -width/2)x+=width;
          }
          path+=(index===0?"M":"L")+x.toFixed(2)+","+point[1].toFixed(2)+" ";
          previousX=x;
        });
        paths.push(path+"Z");
      });
    });
    return paths.join(" ");
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
    if(!militaryMapLayer)return;
    militaryMapLayer.setAttribute("transform","translate("+militaryMapView.x+" "+militaryMapView.y+") translate(500 250) scale("+militaryMapView.scale+") translate(-500 -250)");
    setText("militaryZoomReset",Math.round(militaryMapView.scale*100)+"%");
  }
  function changeMilitaryMapZoom(factor){
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
      const enemyIso=String(war&&(war.opponent_iso2||war.front_state&&war.front_state.enemyCountryIso2)||"").toUpperCase();
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
      if(!militaryMapState.initialViewReady){
        let target=home?[home.x,home.y]:[width/2,height/2];
        if(war&&home&&enemy){
          let enemyX=enemy.x;
          if(enemyX-home.x>width/2)enemyX-=width;
          else if(enemyX-home.x< -width/2)enemyX+=width;
          target=[(home.x+enemyX)/2,(home.y+enemy.y)/2];
        }
        const scale=war&&home&&enemy?1.65:home?1.45:1;
        militaryMapView.scale=scale;
        militaryMapView.x=-(target[0]-width/2)*scale;
        militaryMapView.y=-(target[1]-height/2)*scale;
        militaryMapState.initialViewReady=true;
      }
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

  function resetMilitaryMapView(){
    militaryMapView={scale:1,x:0,y:0};
    applyMilitaryMapTransform();
  }

  function renderMilitaryMap(payload){
    renderMilitarySvgMap(payload);
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
    if(!units.length){root.append(node("div","loading-row","Воинские подразделения ещё не сформированы."));return;}
    units.forEach(unit=>{
      const branch=String(unit.unit_branch||"land").toLowerCase();
      const branchLabel=({land:"Сухопутные войска",guard:"Гвардия",air:"Авиация",naval:"Флот"})[branch]||"Воинская часть";
      const amount=branch==="air"?number(unit.quantity||0,0)+" единиц техники":branch==="naval"?number(unit.quantity||0,0)+" кораблей":number(unit.active_personnel||0,0)+" человек";
      const card=node("article","military-unit-card"),head=node("div","unit-card-head");
      head.append(node("b","",unit.unit_type||"Воинское подразделение"),node("span","unit-branch",branchLabel));
      const stats=node("div","unit-card-stats");
      [["Личный состав",amount],["Готовность",number(unit.readiness||0,0)+"%"],["Снабжение",number(unit.supply||0,0)+"%"],["Техника",number(unit.equipment_level||0,0)+"%"]].forEach(([label,value])=>{
        const item=node("div","unit-stat");item.append(node("small","",label),node("b","",value));stats.append(item);
      });
      card.append(head,stats);
      if(unit.location_lat!=null&&unit.location_lon!=null)card.append(node("small","unit-location","Координаты: "+Number(unit.location_lat).toFixed(2)+", "+Number(unit.location_lon).toFixed(2)));
      root.append(card);
    });
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
    $("militaryZoomIn").addEventListener("click",()=>changeMilitaryMapZoom(1.2));
    $("militaryZoomOut").addEventListener("click",()=>changeMilitaryMapZoom(1/1.2));
    $("militaryZoomReset").addEventListener("click",resetMilitaryMapView);
    $("militaryMapMode").addEventListener("change",()=>{
      militaryMapState.mode=$("militaryMapMode").value;
      if(militaryMapState.mode==="patrol"){
        militaryMapState.draft=[];setText("militaryMapDraftStatus","Отметьте на карте от двух до восьми точек патрульного маршрута.");
        $("saveMilitaryPatrol").disabled=true;
      }else if(militaryMapState.mode==="order")setText("militaryMapDraftStatus","Выберите подразделение и отметьте целевую точку приказа.");
      else setText("militaryMapDraftStatus","Режим обзора: карта не принимает приказы.");
    });
    $("saveMilitaryPatrol").addEventListener("click",()=>{
      if(militaryMapState.draft.length<2)return toast("Для маршрута нужно отметить минимум две точки.");
      const unitId=$("militaryMapUnit").value;if(!unitId)return toast("Выберите подразделение для патруля.");
      const route=militaryMapState.draft.slice();
      void runMilitaryAction({action:"create_patrol",unitId,name:$("militaryPatrolName").value.trim(),patrolType:$("militaryPatrolType").value,route},$("saveMilitaryPatrol"),"Патрульный маршрут сохранён.");
      militaryMapState.draft=[];militaryMapState.mode="view";$("militaryMapMode").value="view";$("saveMilitaryPatrol").disabled=true;
    });
    $("clearMilitaryMapDraft").addEventListener("click",()=>{
      militaryMapState.draft=[];setText("militaryMapDraftStatus","Точки карты очищены.");$("saveMilitaryPatrol").disabled=true;
      if(currentPayload)renderMilitaryMap(currentPayload);
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