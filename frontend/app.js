(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const api = () => window.PRESIDENTIAL_AUTH && window.PRESIDENTIAL_AUTH.api;
  let currentPayload = null, currentGame = null, draftId = null, busy = false;
  let setupCountries = [], selectedCountryId = null, selectedPortrait = "p01";
  let worldMapPromise = null, toastTimer = null;

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
    if(!worldMapPromise){
      const urls=[
        "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson",
        "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_admin_0_countries.geojson"
      ];
      worldMapPromise=(async()=>{
        let lastError;
        for(const url of urls){
          try{
            const response=await fetch(url,{cache:"force-cache"});
            if(!response.ok)throw new Error("HTTP "+response.status);
            const data=await response.json();
            if(!data||!Array.isArray(data.features))throw new Error("Invalid GeoJSON");
            return data;
          }catch(error){lastError=error;}
        }
        throw lastError||new Error("GeoJSON unavailable");
      })();
    }
    return worldMapPromise;
  }
  async function renderWorldMap(iso2){
    const root=$("worldMap");if(!root)return;
    root.replaceChildren(node("div","map-loading","Загружаем географические границы государств…"));
    if(!window.d3||typeof window.d3.geoNaturalEarth1!=="function"){
      root.replaceChildren(node("div","map-loading","Не загрузился модуль карты. Обновите страницу или проверьте доступ к CDN."));
      return;
    }
    try{
      const world=await loadWorldGeoJSON(),features=world.features;
      const width=900,height=390,collection={type:"FeatureCollection",features};
      const projection=window.d3.geoNaturalEarth1().fitExtent([[8,9],[width-8,height-9]],collection);
      const path=window.d3.geoPath(projection);
      const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
      svg.setAttribute("class","world-map-svg");svg.setAttribute("viewBox","0 0 "+width+" "+height);
      svg.setAttribute("role","img");svg.setAttribute("aria-label","Карта мира с государственными границами по данным Natural Earth");
      const ocean=document.createElementNS("http://www.w3.org/2000/svg","rect");
      ocean.setAttribute("class","map-ocean");ocean.setAttribute("width",width);ocean.setAttribute("height",height);svg.append(ocean);
      features.forEach(feature=>{
        const props=feature.properties||{};
        const code=String(props.ISO_A2_EH||props.ISO_A2||"").toUpperCase();
        const shape=document.createElementNS("http://www.w3.org/2000/svg","path");
        shape.setAttribute("d",path(feature)||"");
        shape.setAttribute("class","map-country"+(code===String(iso2||"").toUpperCase()?" active":""));
        shape.setAttribute("tabindex","0");
        const name=props.NAME_RU||props.NAME_EN||props.ADMIN||props.NAME||"Государство";
        shape.setAttribute("aria-label",name);
        shape.setAttribute("data-iso2",code);
        const title=document.createElementNS("http://www.w3.org/2000/svg","title");title.textContent=name;shape.append(title);
        svg.append(shape);
      });
      root.replaceChildren(svg);
    }catch(error){
      root.replaceChildren(node("div","map-loading","Не удалось загрузить карту: "+(error&&error.message?error.message:"ошибка данных")));
    }
  }

  function renderIdentity(game){
    const name=game.name_local||game.name_en||game.save_name||"Государство";
    const flag=game.flag_emoji||"🏳️";
    const region=[game.region,game.government_type].filter(Boolean).join(" · ").toUpperCase();
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
  function renderDecrees(items){
    const root=$("decreeHistory");if(!root)return;root.replaceChildren();
    const published=(items||[]).filter(item=>item.status==="published");
    if(!published.length){root.append(node("div","loading-row","Опубликованных указов пока нет."));return;}
    published.forEach(item=>{
      const row=node("article","decree-row");
      row.append(node("b","", "Указ №"+item.decree_number+" · "+item.title),
        node("p","",item.summary||String(item.body||"").slice(0,200)),node("small","","ОПУБЛИКОВАНО"));
      root.append(row);
    });
  }

  function renderElection(game){
    const phase=String((game.state||{}).phase||"government");
    const active=phase==="election_campaign"||phase==="election";
    const panel=$("electionPanel"),government=$("governmentView");
    if(panel)panel.classList.toggle("hidden",!active);
    if(government)government.classList.toggle("hidden",active);
    if(!active)return;
    const election=(game.state||{}).election||{},remaining=Math.max(0,Number(election.actionsRemaining||0));
    const support=Number(election.candidateSupport||0),opposition=Math.max(0,100-support),control=Number(election.commissionControl||0);
    setText("electionTitle",election.type||"Национальная избирательная кампания");
    setText("electionRound",election.firstElection?"ПЕРВЫЕ ВЫБОРЫ":"ПЕРЕИЗБРАНИЕ · ТУР "+(election.round||2));
    setText("electionDate",dateLabel(election.scheduledDate||game.game_date));
    setText("electionDescription",election.kind==="parliamentary"?"Вам предстоит привести свою партию к победе и получить мандат на формирование правительства.":"Чтобы получить президентский мандат, необходимо набрать большинство голосов на национальных выборах.");
    setText("electionCandidate",game.president_name);setText("electionParty",election.partyName||"Ваша политическая партия");
    const photo=$("electionPortrait");if(photo)photo.replaceChildren(portraitNode((game.state||{}).presidentPortrait||"p01"));
    setText("candidateSupport",support.toFixed(1)+"%");setText("oppositionSupport",opposition.toFixed(1)+"%");
    const candidateBar=$("candidateSupportBar"),oppositionBar=$("oppositionSupportBar");
    if(candidateBar)candidateBar.style.width=Math.min(100,support)+"%";if(oppositionBar)oppositionBar.style.width=opposition+"%";
    setText("campaignActionsRemaining",remaining+" / 4");setText("commissionControl",control+" / 70");
    setText("electionConsequences",control>=70?"ЦИК находится под вашим контролем. Вы можете попытаться отменить конкурентные выборы и установить диктатуру.":"Используйте четыре предвыборных действия, чтобы убедить избирателей. Подчинение ЦИК открывает путь к авторитарному захвату власти, но ухудшает положение страны.");
    document.querySelectorAll("[data-election-action]").forEach(button=>button.disabled=remaining<=0||busy);
    const vote=$("electionVote");if(vote)vote.disabled=remaining>0||busy;
    const capture=$("captureCommission");if(capture)capture.disabled=control>=70||busy;
    const dictator=$("establishDictatorship");if(dictator){dictator.classList.toggle("hidden",control<70);dictator.disabled=busy;}
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
    renderUnits(payload.units);renderDecrees(payload.decrees);renderProjects(currentGame);
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
      if(!result.game){currentGame=null;await openSetup();return;}
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
    }
  }

  function renderCountryGrid(){
    const root=$("countryGrid");if(!root)return;root.replaceChildren();
    const query=String($("countrySearch").value||"").trim().toLocaleLowerCase("ru-RU");
    const countries=setupCountries.filter(country=>[country.name_local,country.name_en,country.region,country.iso2].some(value=>String(value||"").toLocaleLowerCase("ru-RU").includes(query)));
    if(!countries.length){root.append(node("div","loading-row","Страна не найдена."));return;}
    countries.forEach(country=>{
      const button=node("button","country-option"+(String(country.id)===String(selectedCountryId)?" selected":""));
      button.type="button";button.dataset.countryId=country.id;
      button.append(flagNode(country.iso2,country.flag_emoji));
      const copy=node("span","country-option-copy");
      copy.append(node("b","",country.name_local||country.name_en),node("small","",country.region||country.government_type||""));
      button.append(copy,node("span","country-option-check",String(country.iso2||"").toUpperCase()));root.append(button);
    });
    setText("setupSelectionStatus",selectedCountryId?"Выбрано: "+((setupCountries.find(item=>String(item.id)===String(selectedCountryId))||{}).name_local||"страна"):"Сначала выберите государство");
    $("startCampaign").disabled=!selectedCountryId||busy;
  }
  function selectCountry(id){
    selectedCountryId=String(id);
    const country=setupCountries.find(item=>String(item.id)===selectedCountryId);if(!country)return;
    const base=country.baseline_state||{},preview=$("countryPreview");preview.replaceChildren();
    const head=node("div","country-preview-head");head.append(flagNode(country.iso2,country.flag_emoji),node("div","",country.name_local||country.name_en));
    const facts=node("div","country-preview-facts");
    [["ВВП",number(base.gdp,1)+" млрд $"],["Население",number(base.population,1)+" млн"],["Безработица",number(base.unemployment,1)+"%"],["Инфляция",number(base.inflation,1)+"%"]].forEach(pair=>{
      const cell=node("div","");cell.append(node("small","",pair[0]),node("b","",pair[1]));facts.append(cell);
    });
    preview.append(head,facts,node("span","country-preview-government",country.government_type||country.region||""));
    renderCountryGrid();
  }
  async function openSetup(){
    if(busy||!api())return;
    try{
      const result=await api()("/api/presidential/game/setup");
      setupCountries=Array.isArray(result.countries)?result.countries:[];
      selectedCountryId=null;selectedPortrait="p01";
      $("countrySearch").value="";
      $("countryPreview").replaceChildren(node("b","","Страна ещё не выбрана"),node("span","","Выберите государство, чтобы увидеть его стартовые показатели."));
      $("portraitGrid").replaceChildren();
      for(let i=1;i<=16;i++){
        const id="p"+String(i).padStart(2,"0"),button=node("button","portrait-choice"+(id===selectedPortrait?" selected":""));
        button.type="button";button.dataset.portrait=id;button.title="Портрет "+i;button.append(portraitNode(id,"portrait-svg"));$("portraitGrid").append(button);
      }
      const userName=window.PRESIDENTIAL_AUTH&&window.PRESIDENTIAL_AUTH.user&&window.PRESIDENTIAL_AUTH.user.firstName;
      $("presidentName").value=userName?String(userName).slice(0,80):"";
      $("presidentAge").value="45";$("campaignTitle").value="";$("partyName").value="";
      $("politicalCourse").value="social_democracy";$("difficulty").value="normal";$("startYear").value="2026";
      renderCountryGrid();if(!$("setupDialog").open)$("setupDialog").showModal();
    }catch(error){toast("Не удалось загрузить каталог стран: "+error.message);}
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
  $("countrySearch").addEventListener("input",renderCountryGrid);
  $("countryGrid").addEventListener("click",event=>{
    const button=event.target.closest("[data-country-id]");if(button)selectCountry(button.dataset.countryId);
  });
  $("portraitGrid").addEventListener("click",event=>{
    const button=event.target.closest("[data-portrait]");if(!button)return;
    selectedPortrait=button.dataset.portrait;
    document.querySelectorAll(".portrait-choice").forEach(item=>item.classList.toggle("selected",item.dataset.portrait===selectedPortrait));
  });
  $("setupForm").addEventListener("submit",async event=>{
    event.preventDefault();
    if(!selectedCountryId)return toast("Сначала выберите государство.");
    const name=$("presidentName").value.trim(),age=Number($("presidentAge").value);
    if(name.length<3||!Number.isInteger(age)||age<25||age>90)return toast("Проверьте имя и возраст президента.");
    if(currentGame&&!confirm("Начать новую кампанию? Текущее сохранение будет завершено."))return;
    const payload={
      countryId:Number(selectedCountryId),presidentName:name,presidentAge:age,
      campaignTitle:$("campaignTitle").value.trim(),partyName:$("partyName").value.trim(),
      politicalCourse:$("politicalCourse").value,difficulty:$("difficulty").value,startYear:Number($("startYear").value),portraitId:selectedPortrait
    };
    try{await withBusy($("startCampaign"),()=>api()("/api/presidential/game/new",{method:"POST",body:JSON.stringify(payload)}),"Вы создали новую кампанию. Теперь предстоит победить на выборах.");$("setupDialog").close();}catch(_){}
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
  $("electionActions").addEventListener("click",event=>{
    const button=event.target.closest("[data-election-action]");if(!button||busy)return;
    const messages={rally:"Митинги проведены.",debate:"Дебаты завершены.",manifesto:"Предвыборная программа опубликована.",coalition:"Коалиционное соглашение заключено."};
    electionRequest("/api/presidential/game/election/campaign",{action:button.dataset.electionAction},button,messages[button.dataset.electionAction]);
  });
  $("captureCommission").addEventListener("click",()=>{
    if(busy||!confirm("Подчинить Центральную избирательную комиссию? Это увеличит коррупцию, снизит одобрение и политическую стабильность."))return;
    electionRequest("/api/presidential/game/election/commission",{},$("captureCommission"),"Вы усилили контроль над ЦИК. Последствия отражены в показателях страны.");
  });
  $("establishDictatorship").addEventListener("click",()=>{
    if(busy||!confirm("Установить диктатуру? Конкурентные выборы будут отменены, одобрение и стабильность снизятся, коррупция вырастет. Это решение необратимо в рамках этой кампании."))return;
    electionRequest("/api/presidential/game/election/dictatorship",{},$("establishDictatorship"),"Вы установили авторитарный режим. Конкурентные выборы отменены.");
  });
  $("electionVote").addEventListener("click",async()=>{
    if(!currentGame||busy||!confirm("Начать подсчёт голосов? При поражении кампания завершится."))return;
    try{await withBusy($("electionVote"),()=>api()("/api/presidential/game/election/vote",{method:"POST",body:"{}"}),result=>result&&result.won?"Победа! Вы набрали "+result.voteShare+"% голосов.":"Поражение. Вы набрали "+result.voteShare+"% голосов.");}catch(_){}
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

  $("openDecree").addEventListener("click",()=>{
    $("decreePreview").classList.add("hidden");$("generate").classList.remove("hidden");
    $("decreeForm").reset();$("decreeDialog").showModal();
  });
  $("closeDecree").addEventListener("click",()=>$("decreeDialog").close());
  $("decreeForm").addEventListener("submit",async event=>{
    event.preventDefault();const order=$("order").value.trim();
    if(order.length<10)return toast("Опишите инициативу подробнее.");
    const button=$("generate");button.disabled=true;button.textContent="Подготовка документа…";
    try{
      const result=await api()("/api/presidential/game/decree/draft",{method:"POST",body:JSON.stringify({order})});
      const decree=result.decree;draftId=decree.id;
      setText("docTitle",decree.title);setText("decreeSummary",decree.summary||"");
      $("docBody").textContent=decree.body||"";
      setText("docNumber",String(decree.decree_number||"—"));
      setText("docDate",dateLabel(decree.created_at||currentGame.game_date));
      setText("docCountry",currentGame.name_local||currentGame.name_en||"Государство");
      setText("docPresident",currentGame.president_name||"Президент");
      setText("docEffect","При публикации: первоначальные расходы "+money((decree.effects&&decree.effects.preview&&decree.effects.preview.budgetCost)||0)+", срок реализации — "+((decree.effects&&decree.effects.preview&&decree.effects.preview.durationMonths)||"уточняется")+" мес. Показатели будут меняться поэтапно.");
      $("decreePreview").classList.remove("hidden");button.classList.add("hidden");
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

  window.addEventListener("presidential-auth-ready",refreshGame);
  if(window.PRESIDENTIAL_AUTH&&window.PRESIDENTIAL_AUTH.user)refreshGame();
})();