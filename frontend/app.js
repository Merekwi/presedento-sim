(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let currentGame = null;
  let lastDraftId = null;
  const ministersRoot = $("ministers");
  const toastTimer = { value: null };

  function toast(message) {
    $("toast").textContent = message;
    $("toast").classList.remove("hidden");
    clearTimeout(toastTimer.value);
    toastTimer.value = setTimeout(() => $("toast").classList.add("hidden"), 3800);
  }
  function money(value) {
    const n=Number(value||0);
    if (Math.abs(n)>=1000) return (n/1000).toLocaleString("ru-RU",{maximumFractionDigits:2})+" трлн $";
    return n.toLocaleString("ru-RU",{maximumFractionDigits:1})+" млрд $";
  }
  function signedMoney(value) {
    const n=Number(value||0);
    return (n>0?"+":n<0?"−":"")+money(Math.abs(n));
  }
  function dateLabel(value) {
    const date=new Date(String(value).slice(0,10)+"T12:00:00Z");
    return Number.isNaN(date.getTime())?String(value||"—"):new Intl.DateTimeFormat("ru-RU",{day:"numeric",month:"long",year:"numeric",timeZone:"UTC"}).format(date);
  }
  function make(tag,className,text) {
    const node=document.createElement(tag);
    if(className) node.className=className;
    if(text!==undefined) node.textContent=text;
    return node;
  }
  function renderMinisters(items) {
    ministersRoot.replaceChildren();
    if(!items?.length){ministersRoot.textContent="Состав правительства ещё не сформирован.";return}
    items.forEach(m=>{
      const row=make("div","minister");
      const initials=make("div","initials",String(m.full_name||"").split(/\s+/).map(x=>x[0]||"").slice(0,2).join("").toUpperCase());
      const details=make("div");
      details.append(make("b","",m.full_name),make("small","", "Министр: "+m.portfolio+" · Компетентность "+m.competence+"/100"));
      const score=make("strong",Number(m.approval)>=55?"good":"warn",Number(m.approval)+"/100");
      row.append(initials,details,score);ministersRoot.append(row);
    });
  }
  function renderRelations(items) {
    const root=document.querySelector("#diplomacy .relations-list");
    if(!root)return;
    root.replaceChildren();
    if(!items?.length){root.textContent="Дипломатические контакты пока не установлены.";return}
    items.forEach(r=>{
      const row=make("div","relation");
      row.append(make("span","","🌐"),make("b","",r.other_country_name),make("strong",Number(r.relation_score)>=0?"good":"bad",(Number(r.relation_score)>0?"+":"")+r.relation_score));
      root.append(row);
    });
  }
  function renderUnits(items) {
    const root=$("militaryUnits");
    if(!root)return;
    root.replaceChildren();
    (items||[]).forEach(unit=>{
      const row=make("div","relation");
      row.append(make("span","","✦"),make("b","",unit.unit_type),make("strong","",Number(unit.readiness)+"/100"));
      root.append(row);
    });
  }
  function renderNews(items) {
    const root=document.querySelector("#news .news-list");
    if(!root)return;
    root.replaceChildren();
    if(!items?.length){root.textContent="Событий пока нет.";return}
    items.forEach(event=>{
      const row=make("div","news");
      row.append(make("b","",event.headline),make("p","",event.article),make("small","",(event.event_type||"СОБЫТИЕ").toUpperCase()+" · "+dateLabel(event.game_date)));
      root.append(row);
    });
  }
  function renderDecrees(items) {
    const root=$("decreeHistory");
    if(!root)return;
    root.replaceChildren();
    (items||[]).forEach(item=>{
      const row=make("div","news");
      row.append(make("b","",item.decree_number+". "+item.title),make("p","",item.summary||item.body.slice(0,180)),make("small","",item.status==="published"?"ОПУБЛИКОВАНО":item.status==="draft"?"ЧЕРНОВИК":"ОТКЛОНЕНО"));
      root.append(row);
    });
  }
  function renderGame(payload) {
    const game=payload.game;
    if(!game){currentGame=null;return}
    currentGame=game;
    const state=game.state||{};
    const name=game.name_local||game.name_en||game.save_name||"Государство";
    $("country").textContent=name;
    $("flag").textContent=game.flag_emoji||"🏳️";
    $("region").textContent=[game.region,game.government_type].filter(Boolean).join(" · ").toUpperCase();
    $("bio").textContent=game.president_name+", "+game.president_age+" лет · "+(game.president_bio||"Глава государства");
    $("date").textContent=dateLabel(game.game_date);
    $("gdp").textContent=money(state.gdp);
    $("inflation").textContent=Number(state.inflation||0).toLocaleString("ru-RU",{maximumFractionDigits:1})+"%";
    $("budget").textContent=signedMoney(state.budgetBalance);
    $("approval").textContent=Math.round(Number(state.approval||0))+"%";
    $("approvalHero").textContent=Math.round(Number(state.approval||0))+"%";
    $("approvalBar").style.width=Math.max(0,Math.min(100,Number(state.approval||0)))+"%";
    $("stability").textContent=Math.round(Number(state.stability||0))+"/100";
    $("signature").textContent=game.president_name;
    const term=document.querySelector("header small");
    if(term)term.textContent="ПРЕЗИДЕНТСКИЙ СРОК · МЕСЯЦ "+String(game.turn_number||1).padStart(3,"0");
    renderMinisters(payload.ministers);
    renderRelations(payload.relations);
    renderUnits(payload.units);
    renderNews(payload.events);
    renderDecrees(payload.decrees);
  }
  async function refreshGame() {
    const auth=window.PRESIDENTIAL_AUTH;
    if(!auth?.user)return;
    try{
      const result=await auth.api("/api/presidential/game/current");
      if(!result.game){
        toast("Добро пожаловать. Создаём вашу первую страну…");
        const created=await auth.api("/api/presidential/game/new",{method:"POST",body:"{}"});
        const current=await auth.api("/api/presidential/game/current");
        renderGame(current);
        toast("Вы вступили в должность президента "+(created.game.name_local||created.game.name_en)+".");
      } else renderGame(result);
    }catch(error){toast("Не удалось загрузить сохранение: "+error.message)}
  }
  async function startNewGame() {
    if(currentGame&&!confirm("Начать новую президентскую кампанию? Текущая кампания будет завершена."))return;
    const button=$("newGame");button.disabled=true;
    try{
      await window.PRESIDENTIAL_AUTH.api("/api/presidential/game/new",{method:"POST",body:"{}"});
      await refreshGame();
      $("result").classList.add("hidden");
      lastDraftId=null;
      toast("Новая президентская кампания началась.");
    }catch(error){toast("Не удалось начать игру: "+error.message)}
    finally{button.disabled=false}
  }
  $("newGame").addEventListener("click",startNewGame);

  $("generate").addEventListener("click",async()=>{
    const order=$("order").value.trim();
    if(order.length<10){toast("Опишите инициативу подробнее — минимум 10 символов.");return}
    if(!window.PRESIDENTIAL_AUTH?.user){toast("Сначала войдите через Telegram.");return}
    const button=$("generate");button.disabled=true;button.textContent="Подготовка проекта…";
    try{
      const result=await window.PRESIDENTIAL_AUTH.api("/api/presidential/game/decree/draft",{method:"POST",body:JSON.stringify({order})});
      const decree=result.decree;
      lastDraftId=decree.id;
      $("number").textContent="ПРОЕКТ №"+String(decree.decree_number).padStart(3,"0");
      $("docTitle").textContent=decree.title;
      $("docBody").textContent=decree.body;
      $("signature").textContent=currentGame?.president_name||"Президент";
      $("decreeSummary").textContent=decree.summary||"";
      $("result").classList.remove("hidden");
      $("publishDecree").classList.remove("hidden");
      toast("Проект создан. Проверьте текст и последствия перед публикацией.");
    }catch(error){toast("Не удалось подготовить указ: "+error.message)}
    finally{button.disabled=false;button.textContent="✦ Подготовить документ"}
  });
  $("publishDecree").addEventListener("click",async()=>{
    if(!lastDraftId)return;
    const button=$("publishDecree");
    if(!confirm("Опубликовать указ? После подтверждения симулятор рассчитает последствия и продвинет игровое время на один месяц."))return;
    button.disabled=true;button.textContent="Применяем последствия…";
    try{
      const result=await window.PRESIDENTIAL_AUTH.api("/api/presidential/game/decree/publish",{method:"POST",body:JSON.stringify({decreeId:lastDraftId})});
      lastDraftId=null;$("publishDecree").classList.add("hidden");
      await refreshGame();
      const e=result.effects||{};
      toast("Указ опубликован. Одобрение "+(e.approval>=0?"+":"")+e.approval+" п.п.; бюджет: "+signedMoney((e.budgetRevenue||0)-(e.budgetCost||0))+".");
    }catch(error){toast("Не удалось опубликовать указ: "+error.message)}
    finally{button.disabled=false;button.textContent="Опубликовать указ и применить последствия"}
  });
  $("copy").addEventListener("click",async()=>{
    try{await navigator.clipboard.writeText($("docTitle").textContent+"\n\n"+$("docBody").textContent+"\n\nПрезидент: "+$("signature").textContent);toast("Текст документа скопирован")}
    catch(_){toast("Копирование недоступно в этом браузере")}
  });
  $("appoint").addEventListener("click",()=>toast("Управление министрами подключим следующим этапом."));
  $("diplomacyAction").addEventListener("click",()=>toast("Дипломатические действия подключим следующим этапом."));
  window.addEventListener("presidential-auth-ready",refreshGame);
  if(window.PRESIDENTIAL_AUTH?.user)refreshGame();
})();
