(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const api = () => window.PRESIDENTIAL_AUTH && window.PRESIDENTIAL_AUTH.api;
  let currentPayload = null, currentGame = null, draftId = null, busy = false;
  const decreeCache = new Map();
  
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
      const add=(action,label)=>{
        const button=node("button","",label);button.type="button";button.dataset.relationAction=action;
        button.dataset.relationId=relation.id;button.dataset.country=relation.other_country_name;button.disabled=busy;actions.append(button);
      };
      if(!pack.talks||pack.talks.status!=="open")add("consultations","Начать консультации");
      else if(pack.proposal&&pack.proposal.status==="pending"){
        const wait=Math.max(0,Number(pack.proposal.replyTurn||0)-Number(currentGame&&currentGame.turn_number||0));
        if(wait>0)actions.append(node("small","diplomacy-wait","Ответ через "+wait+" мес."));
        else add("resolve_proposal","Получить ответ");
      } else {
        add("propose_trade","Предложить торговый пакт");add("propose_security","Оборонный договор");
      }
      if(Number(relation.relation_score)<=-25)add("sanctions","Санкции");
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
    const index=Math.max(0,Number(election.issueIndex||0));
    const current=agenda[index]||null;
    const support=Number(election.candidateSupport||0),opposition=Math.max(0,100-support);
    const completed=index>=agenda.length&&agenda.length>0;

    setText("electionTitle",election.type||"Национальная избирательная кампания");
    setText("electionRound",election.firstElection?"ПЕРВЫЕ ВЫБОРЫ":"ПЕРЕИЗБРАНИЕ · ТУР "+(election.round||2));
    setText("electionDate",dateLabel(election.scheduledDate||game.game_date));
    setText("electionDescription","Вы не просто рекламируете кандидата: каждое решение формирует программу будущего правительства и меняет поддержку разных слоёв населения.");
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
      if(current){
        const intro=node("div","campaign-issue-intro");
        intro.append(node("div","campaign-issue-number","ВОПРОС "+(index+1)+" ИЗ "+agenda.length));
        intro.append(node("h3","",current.title||"Политический выбор"));
        intro.append(node("p","",current.context||"Стране требуется политическое решение."));
        intro.append(node("h4","",current.question||"Какую позицию должна занять ваша партия?"));
        issueRoot.append(intro);

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
        if(metricRoot.childNodes.length)issueRoot.append(metricRoot);

        const choices=node("div","campaign-choice-grid");
        (current.choices||[]).forEach(choice=>{
          const card=node("article","campaign-choice-card");
          card.append(node("div","campaign-choice-kicker","ВАРИАНТ ПОЛИТИКИ"));
          card.append(node("h4","",choice.title));
          card.append(node("p","campaign-choice-description",choice.description));
          const pros=node("div","campaign-tradeoff campaign-benefit");
          pros.append(node("b","","Потенциальный выигрыш"),node("span","",choice.benefit||""));
          const cons=node("div","campaign-tradeoff campaign-risk");
          cons.append(node("b","","Цена решения"),node("span","",choice.risk||""));
          const submit=node("button","campaign-choice-submit","Выбрать этот курс →");
          submit.type="button";submit.dataset.electionChoice=choice.id;submit.dataset.issueId=current.id;submit.disabled=busy;
          card.append(pros,cons,submit);choices.append(card);
        });
        issueRoot.append(choices);
      }else if(agenda.length){
        issueRoot.append(node("div","campaign-complete-title","Политическая программа сформирована"));
        issueRoot.append(node("p","campaign-complete-copy","Вы определили позицию партии по всем ключевым вопросам. Теперь избиратели оценят не лозунги, а последовательность и последствия предложенной программы."));
      }else{
        issueRoot.append(node("div","campaign-complete-title","Сохранение старой версии кампании"));
        issueRoot.append(node("p","campaign-complete-copy","Эта кампания была создана до появления новой политической системы выборов. Начните новую кампанию, чтобы страна и кандидат были сгенерированы случайно, а выборы проходили по шести содержательным вопросам."));
      }
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
      vote.disabled=!completed||busy;
      vote.textContent=completed?"Провести национальные выборы →":"Сначала завершите программу";
    }
    document.querySelectorAll("[data-election-choice]").forEach(button=>button.disabled=busy);
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

  function renderGame(payload){
    if(!payload||!payload.game){currentGame=null;return;}
    currentPayload=payload;currentGame=payload.game;
    renderIdentity(currentGame);renderMetrics(currentGame);renderElection(currentGame);
    renderMinisters(payload.ministers);renderEvents(payload.events);renderRelations(payload.relations);
    renderUnits(payload.units);renderDecrees(payload.decrees);renderProjects(currentGame);renderInstitutions(currentGame);
    setText("saveStatus","Сохранение синхронизировано");
    const advance=$("advanceTurn"),newGame=$("newGame");
    if(advance)advance.disabled=busy||["election_campaign","election"].includes(currentGame.state&&currentGame.state.phase);
    if(newGame)newGame.disabled=busy;
  }

  async function refreshGame(){
    if(!api()||!window.PRESIDENTIAL_AUTH||!window.PRESIDENTIAL_AUTH.user)return;
    setText("saveStatus","Синхронизация…");
    try{
      const result=await api()("/api/presidential/game/current");
      if(!result.game){currentGame=null;if(busy)needsSetupAfterBusy=true;else await openSetup();return;}
      renderGame(result);
    }catch(error){setText("saveStatus","Ошибка сохранения");toast("Не удалось загрузить кампанию: "+error.message);}
  }

  async function withBusy(button,work,successMessage){
    if(busy)return;
    busy=true;const previous=button?button.textContent:"";
    if(button){button.disabled=true;if(!button.classList.contains("action-card"))button.textContent="Обработка…";}
    document.querySelectorAll("button[data-election-action],button[data-program-start],button[data-relation-action]").forEach(el=>el.disabled=true);
    setText("saveStatus","Сохранение изменений…");
    try{
      const result=await work();
      await refreshGame();
      if(successMessage)toast(typeof successMessage==="function"?successMessage(result):successMessage);
      return result;
    }catch(error){toast("Действие не выполнено: "+(error&&error.message?error.message:"ошибка сервера"));throw error;}
    finally{
      busy=false;
      if(button){button.disabled=false;button.textContent=previous;}
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
    const button=event.target.closest("[data-election-choice]");
    if(!button||busy)return;
    const issueId=button.dataset.issueId,choiceId=button.dataset.electionChoice;
    const issue=(currentGame&&currentGame.state&&currentGame.state.election&&currentGame.state.election.agenda||[]).find(item=>item.id===issueId);
    const choice=(issue&&issue.choices||[]).find(item=>item.id===choiceId);
    if(!issue||!choice)return;
    const confirmation="Вы собираетесь выбрать курс «"+choice.title+"».\n\nПотенциальный выигрыш: "+(choice.benefit||"неизвестен")+"\n\nЦена решения: "+(choice.risk||"неизвестна")+"\n\nРешение станет частью программы партии и будет влиять на страну после победы.";
    if(!confirm(confirmation))return;
    electionRequest("/api/presidential/game/election/decision",{issueId,choiceId},button,"Политическое решение принято. Реакция разных групп избирателей отражена в опросах.");
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

  $("relationsList").addEventListener("click",async event=>{
    const button=event.target.closest("[data-relation-action]");if(!button||busy)return;
    const action=button.dataset.relationAction,country=button.dataset.country||"страну";
    const labels={consultations:"Открыть официальные консультации с ",propose_trade:"Передать торговое предложение стране ",propose_security:"Передать оборонное предложение стране ",resolve_proposal:"Получить официальный ответ от ",sanctions:"Ввести санкции против "};
    if(!confirm((labels[action]||"Продолжить переговоры с ")+country+"?"+(action==="resolve_proposal"?" Ответ может быть положительным или отрицательным.":"")))return;
    try{
      await withBusy(button,()=>api()("/api/presidential/game/diplomacy",{method:"POST",body:JSON.stringify({action,relationId:button.dataset.relationId})}),result=>{
        if(result&&result.accepted===true)return "Соглашение принято. Его экономический или политический эффект будет начисляться постепенно.";
        if(result&&result.accepted===false)return "Партнёр отклонил предложение. Отношения ухудшились.";
        return ({consultations:"Дипломатические консультации открыты.",propose_trade:"Торговое предложение передано. Ответ ожидается через два игровых месяца.",propose_security:"Предложение о сотрудничестве в сфере безопасности передано.",sanctions:"Санкции введены."})[action]||"Дипломатическое решение принято.";
      });
    }catch(_){}
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
    $("decreePreview").classList.add("hidden");$("generate").classList.remove("hidden");
    $("decreePreview").dataset.archived="false";
    $("decreeForm").reset();
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
  $("decreeForm").addEventListener("submit",async event=>{
    event.preventDefault();const order=$("order").value.trim();
    if(order.length<10)return toast("Опишите инициативу подробнее.");
    const button=$("generate");button.disabled=true;button.textContent="Подготовка документа…";
    try{
      const result=await api()("/api/presidential/game/decree/draft",{method:"POST",body:JSON.stringify({order})});
      const decree=result.decree;draftId=decree.id;
      fillOfficialDocument(decree,false);
      toast("Официальный проект подготовлен. Проверьте преамбулу, поручения и финансовое обеспечение.");
    }catch(error){toast("Не удалось подготовить указ: "+error.message);}
    finally{button.disabled=false;button.textContent="Подготовить проект";}
  });
  $("publishDecree").addEventListener("click",async()=>{
    if(!draftId||busy)return;
    if(!confirm("Опубликовать указ? Он создаст финансируемую программу, а показатели будут изменяться постепенно в течение срока исполнения."))return;
    try{
      await withBusy($("publishDecree"),()=>api()("/api/presidential/game/decree/publish",{method:"POST",body:JSON.stringify({decreeId:draftId})}),result=>"Указ опубликован. Начато исполнение программы; проверьте её в разделе государственных программ.");
      draftId=null;$("decreeDialog").close();
    }catch(_){}
  });
  $("copy").addEventListener("click",async()=>{
    try{await navigator.clipboard.writeText($("docTitle").textContent+"\n\n"+$("docBody").textContent);toast("Текст указа скопирован.");}
    catch(_){toast("Копирование недоступно в этом браузере.");}
  });
  $("printDecree").addEventListener("click",()=>window.print());

  window.addEventListener("presidential-auth-ready",refreshGame);
  if(window.PRESIDENTIAL_AUTH&&window.PRESIDENTIAL_AUTH.user)refreshGame();
})();