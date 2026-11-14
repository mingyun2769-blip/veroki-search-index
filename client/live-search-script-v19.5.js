
(function(){
'use strict';


/* =========================================================
   중복 실행 방지
   ========================================================= */

if(window.__VEROKI_SEARCH_V180__){
  return;
}

window.__VEROKI_SEARCH_V180__=true;


if(!/^\/search\/?$/i.test(location.pathname)){
  return;
}


/* =========================================================
   CONFIG
   ========================================================= */

const SEARCH_BOOT_STARTED_AT=Date.now();
const CFG={
  memberIndexApi:'https://search.verokimall.shop',
  indexApi:'https://search-api-production-3e0d.up.railway.app',
  staticIndexUrl:"https://mingyun2769-blip.github.io/veroki-search-index/public-index.json",
  staticIndexMaxAge:26*3600*1000,
  restrictedSourceMenus:['700','85'],
  restrictedCacheFresh:6*3600*1000,
  restrictedCacheMaxAge:48*3600*1000,

  version:
    '19.5-member-cache',

  groupCheck:
    '/veroki-group-check-8f3d',

  marker:
    '#veroki-private-group-marker[data-veroki-auth="1"]',

  privatePathIds:
    new Set([
      '85',

      '624','625','626',
      '627','628','629',

      '630','631','632',

      '633','634','635',

      '636','637','638',
      '639',

      '640','641','642',

      '1121',
      '700'
    ]),

  deliveryKey:
    'veroki_delivery_search_v4',

  pageSize:
    20,

  searchConcurrency:
    6,

  pageConcurrency:
    4,

  detailConcurrency:
    10,

  searchCacheTtl:
    60*1000,

  detailCacheTtl:
    5*60*1000

};


/* =========================================================
   STATE
   ========================================================= */

let runId=0;

let controller=null;

let adminAllowed=null;

let accessPromise=null;

let searchQueueTimer=null;

let lastLaunchKey='';

let lastLaunchAt=0;

let imeEnterPending=false;



let activeReport=null;
let publishedProducts=null,publishedPage=1;
const resultCache=new Map();
const sourceCache=new Map();
let diskTimer=null;
const DISK_KEY="veroki_search_v17_public";
let requestActive=0;
const requestQueue=[];
let serverPauseUntil=0;
let requestStartAt=0;
let networkRequestCount=0;
function abortError(){ return new DOMException('취소됨','AbortError'); }
function waitForRequest(ms,signal){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){ reject(abortError()); return; }
    const done=()=>{signal?.removeEventListener('abort',cancel);resolve();};
    const timer=setTimeout(done,ms);
    const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(abortError());};
    signal?.addEventListener('abort',cancel,{once:true});
  });
}
function pumpRequests(){
  while(requestActive<6 && requestQueue.length){
    const job=requestQueue.shift();
    job.signal?.removeEventListener('abort',job.cancel);
    if(job.signal?.aborted){job.reject(abortError());continue;}
    requestActive++;
    Promise.resolve().then(job.run).then(job.resolve,job.reject).finally(()=>{requestActive--;pumpRequests();});
  }
}
function scheduleRequest(run,signal,priority=1){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(abortError());return;}
    const job={run,signal,resolve,reject,priority};
    job.cancel=()=>{const index=requestQueue.indexOf(job);if(index>=0)requestQueue.splice(index,1);reject(abortError());};
    signal?.addEventListener('abort',job.cancel,{once:true});
    const position=requestQueue.findIndex(other=>other.priority>priority);
    if(position<0)requestQueue.push(job);else requestQueue.splice(position,0,job);
    pumpRequests();
  });
}

const searchCache=
  new Map();


const detailCache=
  new Map();


const detailInflight=
  new Map();


/* =========================================================
   TEXT
   ========================================================= */

function clean(value){

  return String(value||'')
    .replace(/\u00a0/g,' ')
    .replace(/[\u200B-\u200D\uFEFF]/g,'')
    .replace(/\s+/g,' ')
    .trim();

}


function normalize(value){

  let text=
    clean(value);


  try{

    text=
      text.normalize('NFKC');

  }catch(e){}


  return text
    .toLowerCase()
    .replace(/\s+/g,'');

}


function tokenize(query){

  const output=[];

  const used=
    new Set();


  clean(query)
    .split(/\s+/)
    .forEach(function(raw){

      const normalized=
        normalize(raw);


      if(
        !normalized ||
        used.has(normalized)
      ){
        return;
      }


      used.add(normalized);


      output.push({
        raw:raw,
        normalized:normalized
      });

    });


  return output;

}


function matchesAll(
  text,
  words
){

  const target=
    normalize(text);


  return !!target &&
    words.every(function(word){

      return target.indexOf(
        word.normalized
      )!==-1;

    });

}


function matchCount(
  text,
  words
){

  const target=
    normalize(text);

  let count=0;


  for(const word of words){

    if(
      target.indexOf(
        word.normalized
      )!==-1
    ){

      count++;

    }

  }


  return count;

}


/* =========================================================
   INPUT
   ========================================================= */

function getInput(){

  return document.querySelector(
    '.search_widget_v2 .sw2-search-input[name="keyword"]'
  );

}


function getKeyword(){

  const element=
    getInput();


  return element
    ?
    clean(element.value)
    :
    '';

}


function currentSort(){

  const select=
    document.querySelector(
      '.search_widget_v2 .sw2-sort-select'
    );


  return (
    select &&
    select.value
  )
  ?
  select.value
  :
  'consensus_desc';

}


/* =========================================================
   PRODUCT ID
   ========================================================= */

function getIdx(href){

  if(!href){
    return '';
  }


  try{

    return String(
      new URL(
        href,
        location.origin
      )
      .searchParams
      .get('idx')
      ||
      ''
    );

  }catch(e){

    return '';

  }

}


function getPathId(href){

  if(!href){
    return '';
  }


  try{

    const match=
      new URL(
        href,
        location.origin
      )
      .pathname
      .match(
        /^\/(\d+)(?:\/|$)/
      );


    return match
      ?
      match[1]
      :
      '';

  }catch(e){

    return '';

  }

}


/* =========================================================
   동시 처리
   ========================================================= */

async function mapLimit(
  items,
  limit,
  callback
){

  let cursor=0;


  const result=
    new Array(
      items.length
    );


  async function worker(){

    while(true){

      const index=
        cursor++;


      if(
        index>=items.length
      ){

        return;

      }


      result[index]=
        await callback(
          items[index],
          index
        );

    }

  }


  const jobs=[];


  const count=
    Math.min(
      limit,
      items.length
    );


  for(
    let i=0;
    i<count;
    i++
  ){

    jobs.push(
      worker()
    );

  }


  await Promise.all(
    jobs
  );


  return result;

}


/* =========================================================
   FETCH
   ========================================================= */


// Read the complete widget, then cancel the unused page footer. Never cut
// a product list by item count, a byte limit, or the first closing div.
function searchMarkupScanner(){
  let text='',cursor=0,root=-1,depth=0,raw='';
  return {
    append(part){text+=part;},
    full(){return text;},
    scan(){
      while(cursor<text.length){
        if(raw){
          const close=new RegExp('</'+raw+'\\s*>','ig');close.lastIndex=cursor;
          const m=close.exec(text);if(!m)return null;
          cursor=m.index+m[0].length;raw='';continue;
        }
        const start=text.indexOf('<',cursor);if(start<0){cursor=text.length;return null;}
        if(text.startsWith('\x3c!--',start)){
          const end=text.indexOf('\x2d\x2d>',start+4);if(end<0){cursor=start;return null;}
          cursor=end+3;continue;
        }
        // An incomplete comment/tag at a chunk boundary must be retained.
        if(text.length-start<4 && '\x3c!--'.startsWith(text.slice(start))){cursor=start;return null;}
        const lead=text.slice(start).match(/^<\/?([a-z][\w:-]*)\b/i);
        if(!lead){
          if(/^<\/?[a-z]*$/i.test(text.slice(start))){cursor=start;return null;}
          cursor=start+1;continue;
        }
        let quote='',end=-1;
        for(let i=start+lead[0].length;i<text.length;i++){
          const c=text[i];
          if(quote){if(c===quote)quote='';}
          else if(c==='"' || c==="'")quote=c;
          else if(c==='>'){end=i;break;}
        }
        if(end<0){cursor=start;return null;}
        const token=text.slice(start,end+1),name=lead[1].toLowerCase(),closing=token.startsWith('</');
        cursor=end+1;
        if(!closing && (name==='script' || name==='style' || name==='textarea' || name==='title')){raw=name;continue;}
        if(root<0){
          const classes=token.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
          if(!closing && name==='div' && classes && (classes[1] || classes[2] || classes[3] || '').split(/\s+/).includes('search_widget_v2')){root=start;depth=1;}
        }else if(name==='div'){
          depth+=closing?-1:1;
          if(depth===0)return text.slice(root,cursor);
        }
      }
      return null;
    }
  };
}
async function readSearchMarkup(response,signal){
  const scanner=searchMarkupScanner();
  if(!response.body?.getReader){scanner.append(await response.text());return scanner.scan() || scanner.full();}
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8');
  try{
    while(true){
      if(signal?.aborted)throw abortError();
      const chunk=await reader.read();
      if(chunk.done){scanner.append(decoder.decode());return scanner.scan() || scanner.full();}
      scanner.append(decoder.decode(chunk.value,{stream:true}));
      const markup=scanner.scan();
      if(markup){await reader.cancel().catch(()=>{});return markup;}
    }
  }finally{try{await reader.cancel();}catch(e){}reader.releaseLock();}
}

async function rawFetchDocument(url,signal){
  let lastError;
  for(let attempt=0;attempt<3;attempt++){
    if(signal?.aborted) throw abortError();
    try{
      return await scheduleRequest(async()=>{
        
        requestStartAt=Math.max(requestStartAt,Date.now(),serverPauseUntil);
        const delay=requestStartAt-Date.now();
        requestStartAt+=200;
        await waitForRequest(delay,signal);
        if(serverPauseUntil>Date.now())await waitForRequest(serverPauseUntil-Date.now(),signal);

        const request=new AbortController(), cancel=()=>request.abort();
        signal?.addEventListener('abort',cancel,{once:true});
        const timer=setTimeout(cancel,20000);
        try{
          networkRequestCount++;
          const response=await fetch(url,{credentials:'same-origin',cache:'no-store',redirect:'follow',signal:request.signal});
          if(response.status===429){
            const header=response.headers.get('Retry-After');
            let retry=Number(header)*1000;
            if(!Number.isFinite(retry) || retry<=0) retry=Date.parse(header)-Date.now();
            if(!Number.isFinite(retry) || retry<=0) retry=30000;
            serverPauseUntil=Math.max(serverPauseUntil,Date.now()+retry);
            const error=new Error('요청 과다로 검색을 중단했습니다. 잠시 후 다시 검색해 주세요.');error.rateLimited=true;throw error;
          }
          if(!response.ok) throw new Error('HTTP '+response.status);
          const requested=new URL(url,location.origin), finalUrl=new URL(response.url || url,location.origin);
          if(finalUrl.origin!==requested.origin || finalUrl.pathname.replace(/\/+$/,'')!==requested.pathname.replace(/\/+$/,'')) throw new Error('페이지가 다른 주소로 이동했습니다');
          const template=document.createElement('template');
          template.innerHTML=requested.pathname.replace(/\/+$/,'')==='/search' ? await readSearchMarkup(response,signal) : await response.text();
          const doc=requested.pathname.replace(/\/+$/,'')==='/search' ? template.content.querySelector('.search_widget_v2') : template.content;
          if(!doc || (requested.pathname.replace(/\/+$/,'')==='/search' && !doc.querySelector('.sw2-result'))) throw new Error('검색 결과 영역을 확인할 수 없습니다');
          return doc;
        }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
      },signal,new URL(url,location.origin).pathname==='/search'?0:1);
    }catch(error){
      if(signal?.aborted) throw abortError();
      if(error.rateLimited)throw error;
      lastError=error;
      if(attempt<2 && serverPauseUntil<=Date.now()) await waitForRequest(300*(attempt+1),signal);
    }
  }
  throw lastError;
}


async function fetchSearchDocument(url,signal){
  const key=cacheScope()+'|'+url;
  const cached=searchCache.get(key);
  if(cached && Date.now()-cached.time<CFG.searchCacheTtl)return cached.doc;
  const doc=await rawFetchDocument(url,signal);
  searchCache.set(key,{time:Date.now(),doc});return doc;
}


/* =========================================================
   ADMIN ACCESS
   ========================================================= */

function loggedIn(){

  return !!(
    document.body &&
    document.body.classList.contains(
      'loggedin'
    )
  );

}


async function checkAccess(){

  if(adminAllowed!==null){

    return adminAllowed;

  }


  if(accessPromise){

    return accessPromise;

  }


  if(!loggedIn()){

    adminAllowed=false;

    return false;

  }


  accessPromise=
    (
      async function(){

        try{

          networkRequestCount++;
          const response=
            await fetch(
              CFG.groupCheck+
              '?v102='+
              Date.now(),
              {

                credentials:'same-origin',

                cache:'no-store',

                redirect:'follow'

              }
            );


          if(!response.ok){

            return false;

          }


          const finalUrl=
            new URL(
              response.url,
              location.origin
            );


          if(
            finalUrl.pathname
              .replace(/\/+$/,'')
            !==
            CFG.groupCheck
              .replace(/\/+$/,'')
          ){

            return false;

          }


          const doc=
            new DOMParser()
              .parseFromString(
                await response.text(),
                'text/html'
              );


          return !!doc.querySelector(
            CFG.marker
          );


        }catch(e){

          return false;

        }

      }
    )();


  try{

    adminAllowed=
      await accessPromise;


    return adminAllowed;

  }finally{

    accessPromise=null;

  }

}


function isPrivate(product){

  if(adminAllowed===true && loggedIn()){

    return false;

  }


  const pathId=
    getPathId(
      product.href
    );


  return !!(
    pathId &&
    CFG.privatePathIds.has(pathId)
  );

}


/* =========================================================
   DELIVERY
   ========================================================= */

function readDelivery(){

  try{

    const value=
      sessionStorage.getItem(
        CFG.deliveryKey
      );


    if(
      value==='all' ||
      value==='domestic' ||
      value==='overseas'
    ){

      return value;

    }


  }catch(e){}


  return 'domestic';

}


function deliveryMode(){

  const button=
    document.querySelector(
      '#veroki-delivery-filter button.active'
    );


  return button
    ?
    button.dataset.delivery
    :
    readDelivery();

}


function deliveryMatches(product){

  const mode=
    deliveryMode();


  if(mode==='all'){

    return true;

  }


  const text=
    product.title ||
    product.cardText ||
    '';


  if(mode==='domestic'){

    return /^\s*\[\s*국내배송\s*\]/
      .test(text);

  }


  return /^\s*\[\s*해외배송\s*\]/
    .test(text);

}


function moveDelivery(){

  const widget=
    document.querySelector(
      '.search_widget_v2'
    );


  const row=
    document.getElementById(
      'veroki-delivery-filter-row'
    );


  if(
    !widget ||
    !row
  ){

    return;

  }


  const search=
    widget.querySelector(
      '.sw2-search'
    );


  const nav=
    widget.querySelector(
      '.sw2-nav'
    );


  if(
    search &&
    search.nextElementSibling!==row
  ){

    search.insertAdjacentElement(
      'afterend',
      row
    );

  }


  if(
    nav &&
    row.nextElementSibling!==nav
  ){

    row.insertAdjacentElement(
      'afterend',
      nav
    );

  }

}


function makeDelivery(){

  let row=
    document.getElementById(
      'veroki-delivery-filter-row'
    );


  if(!row){

    row=
      document.createElement(
        'div'
      );


    row.id=
      'veroki-delivery-filter-row';


    row.innerHTML=
      '<div class="col-form-label text-start">배송 구분</div>'+
      '<div>'+
        '<div id="veroki-delivery-filter">'+
          '<button type="button" data-delivery="all">전체</button>'+
          '<button type="button" data-delivery="domestic">국내배송</button>'+
          '<button type="button" data-delivery="overseas">해외배송</button>'+
        '</div>'+
      '</div>';


    document.querySelector(
      '.search_widget_v2 .sw2-top'
    )
    ?.appendChild(
      row
    );

  }


  const selected=
    readDelivery();


  row.querySelectorAll(
    'button[data-delivery]'
  )
  .forEach(function(button){

    button.classList.toggle(
      'active',
      button.dataset.delivery===selected
    );


    if(button.dataset.v102){

      return;

    }


    button.dataset.v102='1';


    button.addEventListener(
      'click',
      function(){

        row.querySelectorAll(
          'button[data-delivery]'
        )
        .forEach(function(other){

          other.classList.toggle(
            'active',
            other===button
          );

        });


        try{

          sessionStorage.setItem(
            CFG.deliveryKey,
            button.dataset.delivery
          );

        }catch(e){}


        queueSearch(
          'delivery',
          0
        );

      }
    );

  });


  moveDelivery();

}


/* =========================================================
   PRODUCT CARD EXTRACTION
   ========================================================= */

function findProductBox(link){
  const native=link.closest('.sw2-card');
  if(native)return native;

  let node=link;

  let best=
    link.parentElement ||
    link;


  for(
    let depth=0;
    depth<8 &&
    node &&
    node.parentElement;
    depth++
  ){

    node=
      node.parentElement;


    const ids=
      new Set();


    node.querySelectorAll(
      'a[href*="idx="]'
    )
    .forEach(function(anchor){

      const idx=
        getIdx(
          anchor.getAttribute('href')
        );


      if(idx){

        ids.add(idx);

      }

    });


    if(ids.size===1){

      best=node;

    }else if(ids.size>1){

      break;

    }

  }


  return best;

}


function badTitle(value){

  const title=
    clean(value)
      .toLowerCase();


  return (
    !title ||
    [
      '상품',
      '상품 보기',
      '상품보기',
      '제품',
      '제품 보기',
      '제품보기',
      '쇼핑'
    ]
    .includes(title)
  );

}


function extractProducts(doc){

  if(!doc){

    return [];

  }


  const scope=
    doc.querySelector(
      '.search_widget_v2 .sw2-result'
    )
    ||
    doc.querySelector(
      '.search_widget_v2'
    )
    ||
    doc;


  const map=
    new Map();


  scope.querySelectorAll(
    'a[href*="idx="]'
  )
  .forEach(function(link){

    const href=
      link.getAttribute(
        'href'
      );


    const idx=
      getIdx(href);


    if(
      !idx ||
      map.has(idx)
    ){

      return;

    }


    const box=
      findProductBox(
        link
      );


    const imageNode=
      box.querySelector(
        'img'
      );


    let title=
      imageNode
      ?
      clean(
        imageNode.getAttribute('alt') ||
        imageNode.getAttribute('title') ||
        ''
      )
      :
      '';


    {

      const titleNode=
        box.querySelector(
          '.sw2-card-name,'+
          '.sw2-item-title,'+
          '.sw2-product-title,'+
          '.sw2-name,'+
          '.item_name,'+
          '.item-name,'+
          '.product-name,'+
          '.product_name,'+
          '.goods-name,'+
          '.goods_name,'+
          '.text-bold,'+
          'h2,'+
          'h3'
        );


      if(titleNode && !badTitle(titleNode.textContent)){

        title=
          clean(
            titleNode.textContent
          );

      }

    }


    let price='';


    const priceMatch=
      clean(
        box.textContent
      )
      .match(
        /[\d,]+\s*원/
      );


    if(priceMatch){

      price=
        priceMatch[0]
          .replace(/\s+/g,'');

    }


    const image=
      imageNode
      ?
      (
        imageNode.getAttribute('data-original') ||
        imageNode.getAttribute('data-src') ||
        imageNode.getAttribute('src') ||
        ''
      )
      :
      '';


    map.set(
      idx,
      {

        idx:idx,

        href:href,

        title:title,

        price:price,

        image:image,

        cardText:
          clean(
            box.textContent ||
            ''
          )

      }
    );

  });


  return Array.from(
    map.values()
  );

}


/* =========================================================
   SEARCH SOURCE
   ========================================================= */

function searchUrl(
  term,
  page
){

  const url=
    new URL(
      '/search',
      location.origin
    );


  url.searchParams.set(
    'type',
    'shopping'
  );


  url.searchParams.set(
    'sort',
    'consensus_desc'
  );


  url.searchParams.set(
    'keyword',
    term
  );


  if(page>1){

    url.searchParams.set(
      'page',
      String(page)
    );

  }


  return url.pathname+
    url.search;

}


function paginationMax(doc){
  let max=1;
  const scope=doc.querySelector('.search_widget_v2') || doc;
  scope.querySelectorAll('a[href*="page="],[data-page],.pagination a,.paging a,[onclick*="page"]').forEach(link=>{
    let page=Number(link.getAttribute('data-page') || 0);
    try{ page=Math.max(page,Number(new URL(link.getAttribute('href') || '',location.origin).searchParams.get('page') || 0)); }catch(e){}
    const onclick=link.getAttribute('onclick') || '';
    const match=onclick.match(/(?:page\s*[=:,(]\s*|changePage\s*\(\s*)(\d+)/i);
    if(match) page=Math.max(page,Number(match[1]));
    if(link.closest('.pagination,.paging') && /^\d+$/.test(clean(link.textContent))) page=Math.max(page,Number(clean(link.textContent)));
    if(Number.isSafeInteger(page) && page>max) max=page;
  });
  return max;
}



function relaxedTerm(word){
  const raw=clean(word.raw);
  return /^[가-힣]+$/.test(raw) && Array.from(raw).length>=3 ? Array.from(raw).slice(0,2).join('') : raw;
}

function addCandidate(map,product,source){
  if(!product || !/^\d+$/.test(product.idx)) return;
  const old=map.get(product.idx);
  if(old){
    old.sources.add(source);
    const oldRestricted=CFG.privatePathIds.has(getPathId(old.product.href));
    const newRestricted=CFG.privatePathIds.has(getPathId(product.href));
    // A restricted alias alone stays restricted. A separately indexed public
    // alias of the same ID is preferred regardless of response arrival order.
    if(oldRestricted && !newRestricted){
      old.product={...product,cardText:clean((product.cardText || '')+' '+(old.product.cardText || ''))};
    }
    for(const field of ['title','price','image']) if(!old.product[field] && product[field]) old.product[field]=product[field];
    if(product.cardText && !(old.product.cardText || '').includes(product.cardText)) old.product.cardText=clean((old.product.cardText || '')+' '+product.cardText);
    return;
  }
  map.set(product.idx,{product:product,sources:new Set([source])});
}

function sourceSpecs(query,words){
  const terms=new Map([[clean(query),'exact']]);
  words.forEach((word,index)=>{
    if(!terms.has(word.raw)) terms.set(word.raw,'word:'+index);
    const relaxed=relaxedTerm(word);
    if(!terms.has(relaxed)) terms.set(relaxed,'relaxed:'+index);
  });
  return Array.from(terms,([term,label])=>({term,label}));
}

// A pagination number is a lower bound: later pages can reveal a new block.
// Stop only on a confirmed empty page beyond that bound, never on overlap
// with another query, a short page, or a candidate/detail count limit.
async function collectSourceNetwork(spec,map,signal,report,onProgress){
  const stat={term:spec.term,label:spec.label,pages:0,products:0,complete:false};
  report.sources.push(stat);
  const local=new AbortController(),cancel=()=>local.abort();
  signal.addEventListener('abort',cancel,{once:true});
  const pending=new Map(),signatures=new Set();
  let next=1,knownThrough=1,gap=false;
  const start=page=>{
    const task=fetchSearchDocument(searchUrl(spec.term,page),local.signal).then(doc=>({page,doc}),error=>({page,error}));
    pending.set(page,task);
  };
  try{
    if(signal.aborted)throw abortError();
    start(next++);
    while(pending.size){
      const response=await Promise.race(pending.values());
      pending.delete(response.page);
      if(signal.aborted)throw abortError();
      if(response.error){
        if(response.error.rateLimited)throw response.error;
        report.issues.push(spec.term+' '+response.page+'페이지: '+response.error.message);return;
      }
      stat.pages++;
      const rows=extractProducts(response.doc);
      knownThrough=Math.max(knownThrough,paginationMax(response.doc));
      if(!rows.length){
        if(response.page>knownThrough || (response.page===1 && knownThrough===1)){
          stat.complete=!gap;return;
        }
        gap=true;report.issues.push(spec.term+' '+response.page+'페이지에 상품을 확인하지 못했습니다');
      }else{
        const signature=rows.map(p=>p.idx).sort().join(',');
        if(signatures.has(signature)){
          report.issues.push(spec.term+' '+response.page+'페이지가 반복되어 전체 수집을 확인하지 못했습니다');return;
        }
        signatures.add(signature);stat.products+=rows.length;
        rows.forEach(p=>addCandidate(map,p,spec.label));onProgress();
      }
      // Refill slots as each page completes; do not wait for the slowest
      // response in a batch. Only known pages can be prefetched.
      while(pending.size<6 && next<=knownThrough)start(next++);
      // Probe beyond the known lower bound only after every known page settled.
      if(!pending.size)start(next++);
    }
  }finally{local.abort();signal.removeEventListener('abort',cancel);}
}

/* DETAIL */

function cacheScope(){
  return !loggedIn() ? 'public' : adminAllowed===true ? 'admin' : 'member';
}
function sourceKey(term){return cacheScope()+'|'+String(term);}
function readSource(term){
  const value=sourceCache.get(sourceKey(term));
  if(value && Date.now()-value.time<60000)return value;
  return null;
}
function saveDiskLater(){
  if(cacheScope()!=='public')return;
  clearTimeout(diskTimer);diskTimer=setTimeout(saveDisk,50);
}
function saveDisk(){
  if(cacheScope()!=='public')return;
  try{
    const now=Date.now(),records=[];
    sourceCache.forEach((value,key)=>{
      if(key.startsWith('public|') && now-value.time<60000){
        const products=value.products.filter(p=>!isPrivate(p));
        records.push({kind:'source',key,value:{...value,products}});
      }
    });
    detailCache.forEach((value,key)=>{if(key.startsWith('public|') && now-value.time<CFG.detailCacheTtl)records.push({kind:'detail',key,value});});
    resultCache.forEach((value,key)=>{
      if(key.endsWith('|public') && now-value.time<60000){
        const items=value.items.filter(i=>!isPrivate(i.product)).map(i=>({product:i.product,sources:Array.from(i.sources)}));
        records.push({kind:'result',key,value:{...value,items}});
      }
    });
    records.sort((a,b)=>b.value.time-a.value.time);
    const kept=[];let size=0;
    for(const record of records){
      const bytes=JSON.stringify(record).length;
      if(size+bytes>900000)continue; // Evict entire cache entries, never search results.
      kept.push(record);size+=bytes;
    }
    sessionStorage.setItem(DISK_KEY,JSON.stringify({version:17,records:kept}));
  }catch(e){ /* Storage disabled/full: continue with network, no result limit. */ }
}
function restoreDisk(){
  try{
    // An explicit browser refresh is the user's request for fresh product data.
    if(performance.getEntriesByType('navigation')[0]?.type==='reload'){
      sessionStorage.removeItem(DISK_KEY);return;
    }
    const saved=JSON.parse(sessionStorage.getItem(DISK_KEY) || 'null');
    if(saved?.version!==17 || !Array.isArray(saved.records))return;
    const now=Date.now();
    for(const record of saved.records){
      const value=record.value;
      if(!value || !Number.isFinite(value.time) || value.time>now)continue;
      if(record.kind==='source' && record.key.startsWith('public|') && now-value.time<60000 && Array.isArray(value.products))sourceCache.set(record.key,value);
      if(record.kind==='detail' && record.key.startsWith('public|') && now-value.time<CFG.detailCacheTtl && typeof value.text==='string')detailCache.set(record.key,value);
      if(record.kind==='result' && record.key.endsWith('|public') && now-value.time<60000 && Array.isArray(value.items)){
        value.items=value.items.map(i=>({product:i.product,sources:new Set(i.sources)}));resultCache.set(record.key,value);
      }
    }
  }catch(e){try{sessionStorage.removeItem(DISK_KEY);}catch(e){} }
}
async function collectSource(spec,map,signal,report,onProgress){
  const cached=readSource(spec.term);
  if(cached){
    cached.products.forEach(p=>addCandidate(map,p,spec.label));
    report.sources.push({term:spec.term,label:spec.label,pages:cached.pages,products:cached.products.length,complete:true,cached:true});
    onProgress();return true;
  }
  const own=new Map();
  await collectSourceNetwork(spec,own,signal,report,()=>{
    own.forEach(item=>addCandidate(map,item.product,spec.label));onProgress();
  });
  const stat=report.sources.filter(s=>s.label===spec.label).at(-1);
  if(stat?.complete){
    sourceCache.set(sourceKey(spec.term),{time:Date.now(),pages:stat.pages,products:Array.from(own.values(),i=>i.product)});
    saveDiskLater();return true;
  }
  return false;
}
async function probeSource(spec,signal,report){
  const cached=readSource(spec.term);
  if(cached)return {...spec,products:cached.products,maxPage:cached.pages,complete:true,cached:true};
  try{
    const doc=await fetchSearchDocument(searchUrl(spec.term,1),signal);
    const products=extractProducts(doc),maxPage=paginationMax(doc);
    report.probes.push({term:spec.term,count:products.length,maxPage});
    if(!products.length && maxPage===1){
      sourceCache.set(sourceKey(spec.term),{time:Date.now(),pages:1,products:[]});saveDiskLater();
      return {...spec,products,maxPage,complete:true};
    }
    return {...spec,products,maxPage,complete:false};
  }catch(error){
    if(signal.aborted || error.rateLimited)throw error;
    report.probes.push({term:spec.term,error:error.message});
    return {...spec,products:[],maxPage:Infinity,failed:true};
  }
}
restoreDisk();
window.addEventListener('pagehide',saveDisk);

function jsonLdProduct(doc){

  let found=null;


  function walk(value){

    if(
      !value ||
      found
    ){

      return;

    }


    if(
      Array.isArray(value)
    ){

      value.forEach(
        walk
      );

      return;

    }


    if(
      typeof value!=='object'
    ){

      return;

    }


    const type=
      value['@type'];


    if(
      type==='Product' ||
      (
        Array.isArray(type) &&
        type.includes('Product')
      )
    ){

      found=value;

      return;

    }


    if(value['@graph']){

      walk(
        value['@graph']
      );

    }

  }


  doc.querySelectorAll(
    'script[type="application/ld+json"]'
  )
  .forEach(function(script){

    if(found){

      return;

    }


    try{

      walk(
        JSON.parse(
          script.textContent
        )
      );


    }catch(e){}

  });


  return found;

}


function detailText(doc){

  const parts=[];


  const product=
    jsonLdProduct(
      doc
    );


  if(product){

    if(product.name){

      parts.push(
        clean(
          product.name
        )
      );

    }


    if(product.description){

      parts.push(
        clean(
          product.description
        )
      );

    }

  }


  const description=
    doc.querySelector(
      'meta[name="description"]'
    );


  if(description){

    parts.push(
      clean(
        description.content
      )
    );

  }


  [
    '#prod_detail',
    '._prod_detail_detail',
    '.shop_view_detail',
    '.shop_view_body',
    '.detail_body',
    '.detail-content',
    '.product-detail',
    '.goods_summary',
    '.goods-summary',
    '.fr-view'
  ]
  .forEach(function(selector){

    doc.querySelectorAll(
      selector
    )
    .forEach(function(node){

      const clone=
        node.cloneNode(true);


      clone.querySelectorAll(
        'script,'+
        'style,'+
        'noscript,'+
        '.detail_review_wrap,'+
        '.detail_qna_wrap,'+
        '.detail_review_wrap_mobile,'+
        '.detail_qna_wrap_mobile,'+
        '[class*="recommend"],'+
        '[class*="related"],'+
        '[class*="relation"],'+
        '[class*="recent"],'+
        '.shop-item,'+
        '._shop_item'
      )
      .forEach(function(element){

        element.remove();

      });


      const text=
        clean(
          clone.textContent
        );


      if(text){

        parts.push(text);

      }

    });

  });


  return parts.join(' ');

}


async function getDetail(product,signal){
  const key=cacheScope()+'|'+product.idx+'|'+product.href;
  const cached=detailCache.get(key);
  if(cached && Date.now()-cached.time<CFG.detailCacheTtl) return cached.text;
  // Never share a promise attached to a cancelled previous search.
  const doc=await rawFetchDocument(product.href || '/shop_view/?idx='+product.idx,signal);
  const text=detailText(doc);
  if(!text) throw new Error('상품 상세정보를 확인할 수 없습니다');
  detailCache.set(key,{time:Date.now(),text:text});
  saveDiskLater();
  return text;
}


/* =========================================================
   RENDER
   ========================================================= */

function resultArea(){
  const native=document.querySelector('.search_widget_v2 .sw2-result');
  if(!native)return null;
  native.style.setProperty('display','none','important');
  let area=document.getElementById('veroki-search-results');
  if(!area){
    area=document.createElement('div');area.id='veroki-search-results';
    area.style.cssText='width:100%;max-width:100%;box-sizing:border-box';
    native.insertAdjacentElement('afterend',area);
  }
  return area;
}


function renderLoading(){
  publishedProducts=null;

  const area=
    resultArea();


  if(area){

    area.innerHTML=
      '<div class="veroki-v102-loading">'+
        '<div class="veroki-v102-skeleton">'+
          '<div class="veroki-v102-skeleton-thumb"></div>'+
          '<div class="veroki-v102-skeleton-body">'+
            '<div class="veroki-v102-skeleton-line"></div>'+
            '<div class="veroki-v102-skeleton-line short"></div>'+
          '</div>'+
        '</div>'+
      '</div>';

  }

}


function renderEmpty(){

  const area=
    resultArea();


  if(area){

    area.innerHTML=
      '<div class="veroki-v102-empty">'+
        '<strong>검색어와 일치하는 결과를 찾지 못했어요</strong>'+
        '<span>검색어를 확인한 후 다시 시도해 주세요.</span>'+
      '</div>';

  }

}


function createCard(product){

  const card=
    document.createElement(
      'a'
    );


  card.className=
    'veroki-v102-card';


  card.href=
    product.href ||
    (
      '/shop_view/?idx='+
      product.idx
    );


  const thumb=
    document.createElement(
      'div'
    );


  thumb.className=
    'veroki-v102-thumb';


  if(product.image){

    const image=
      document.createElement(
        'img'
      );


    image.src=
      product.image;


    image.alt=
      product.title ||
      '상품 이미지';


    thumb.appendChild(
      image
    );

  }


  const info=
    document.createElement(
      'div'
    );


  info.className=
    'veroki-v102-info';


  const title=
    document.createElement(
      'div'
    );


  title.className=
    'veroki-v102-title';


  title.textContent=
    product.title ||
    '';


  info.appendChild(
    title
  );


  if(product.price){

    const price=
      document.createElement(
        'div'
      );


    price.className=
      'veroki-v102-price';


    price.textContent=
      product.price;


    info.appendChild(
      price
    );

  }


  card.appendChild(
    thumb
  );


  card.appendChild(
    info
  );


  return card;

}


function createPaging(
  total,
  current,
  callback
){

  const pages=
    Math.ceil(
      total/
      CFG.pageSize
    );


  if(pages<=1){

    return null;

  }


  const nav=
    document.createElement(
      'div'
    );


  nav.className=
    'veroki-v102-paging';


  function add(
    text,
    page,
    active,
    disabled
  ){

    const button=
      document.createElement(
        'button'
      );


    button.type='button';

    button.textContent=text;

    button.disabled=
      !!disabled;


    if(active){

      button.classList.add(
        'active'
      );

    }


    if(
      !active &&
      !disabled
    ){

      button.addEventListener(
        'click',
        function(){

          callback(page);

        }
      );

    }


    nav.appendChild(button);

  }


  add(
    '‹',
    current-1,
    false,
    current<=1
  );


  let start=
    Math.max(
      1,
      current-3
    );


  let end=
    Math.min(
      pages,
      start+6
    );


  start=
    Math.max(
      1,
      end-6
    );


  for(
    let page=start;
    page<=end;
    page++
  ){

    add(
      String(page),
      page,
      page===current,
      false
    );

  }


  add(
    '›',
    current+1,
    false,
    current>=pages
  );


  return nav;

}


function renderResults(
  products,
  page
){
  publishedProducts=products.slice();
  publishedPage=page || 1;

  const area=
    resultArea();


  if(!area){

    return;

  }


  if(!products.length){

    renderEmpty();

    return;

  }


  page=
    page || 1;


  area.innerHTML='';


  const list=
    document.createElement(
      'div'
    );


  list.className=
    'veroki-v102-list';


  const start=
    (page-1)*
    CFG.pageSize;


  const end=
    Math.min(
      products.length,
      start+
      CFG.pageSize
    );


  for(
    let i=start;
    i<end;
    i++
  ){

    list.appendChild(
      createCard(
        products[i]
      )
    );

  }


  area.appendChild(list);


  const paging=
    createPaging(
      products.length,
      page,

      function(next){

        renderResults(
          products,
          next
        );


        if(activeReport) renderSearchStatus(activeReport,!activeReport.finishedAt);

        document.querySelector(
          '.search_widget_v2'
        )
        ?.scrollIntoView({
          behavior:'smooth',
          block:'start'
        });

      }
    );


  if(paging){

    area.appendChild(
      paging
    );

  }

}


function score(item,words){
  const title=normalize(item.product.title);
  // Rank must not depend on which request finishes first or how many
  // discovery sources later happen to return the same product.
  let value=0;
  for(const word of words) if(title.includes(word.normalized)) value+=10000;
  if(title.includes(words.map(w=>w.normalized).join('')))value+=3000;
  return value;
}


/* =========================================================
   SEARCH
   ========================================================= */


async function prepareMemberProof(base,parentSignal){
 const request=new AbortController(),cancel=()=>request.abort();
 if(parentSignal?.aborted)request.abort();
 parentSignal?.addEventListener('abort',cancel,{once:true});
 const timer=setTimeout(cancel,10000),signal=request.signal;
 try{
 networkRequestCount+=2;
 const [challengeResponse,tokenResponse]=await Promise.all([
  fetch(new URL('/v19/challenge',base),{method:'POST',credentials:'include',cache:'no-store',signal}),
  fetch('/ajax/make_token.cm?form',{method:'POST',credentials:'same-origin',cache:'no-store',signal,
   headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:new URLSearchParams({expire:'86400'})})
 ]);
 if(!challengeResponse.ok)throw new Error('회원 검색 확인 HTTP '+challengeResponse.status);
 if(!tokenResponse.ok)throw new Error('회원 검색 확인 준비 실패');
 const [challenge,token]=await Promise.all([challengeResponse.json(),tokenResponse.json()]);
 if(!/^[a-f0-9]{48}$/.test(challenge.id) || !/^[a-f0-9]{64}$/.test(challenge.nonce))throw new Error('회원 검색 확인값 오류');
 if(!['string','number'].includes(typeof token.token) || !token.token || !['string','number'].includes(typeof token.token_key) || !token.token_key)
  throw new Error('회원 검색 확인 준비값 오류');
 return {challenge,token};
 }finally{clearTimeout(timer);parentSignal?.removeEventListener('abort',cancel);}
}
async function memberProofSearch(query,base,signal,preparation){
 const prepared=preparation?await preparation:await prepareMemberProof(base,signal);
 if(prepared.error)throw prepared.error;
 const {challenge,token}=prepared;
 const body=new URLSearchParams({board_code:'b20261012a4d5e2afc2363',unit_code:'u20260805c4cc9ad432e68',
  widget_code:'w20261012814d87bb29093',board_name:'베로키몰 회원 검색 검증',
  write_token:token.token,write_token_key:token.token_key,input_10b19e551a3cd:challenge.nonce,textarea_ad172da8faa9b:''});
 networkRequestCount++;
 const submitted=await fetch('/ajax/form_add.cm',{method:'POST',credentials:'same-origin',cache:'no-store',signal,
  headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body});
 if(!submitted.ok || (await submitted.json()).msg!=='SUCCESS')throw new Error('회원 검색 확인 제출 실패');
 networkRequestCount++;
 return fetch(new URL('/v19/member-search',base),{method:'POST',credentials:'include',
  headers:{'Content-Type':'application/json'},body:JSON.stringify({id:challenge.id,q:query}),cache:'no-store',signal});
}

/* STATIC PUBLIC INDEX (v19.3) — public products only, built from public category listings. */
let staticIndexPromise=null;
function loadStaticIndex(){
  if(staticIndexPromise)return staticIndexPromise;
  const started=Date.now();
  networkRequestCount++;
  const getIndex=mode=>fetch(CFG.staticIndexUrl,{credentials:'omit',cache:mode}).then(response=>{
    if(!response.ok)throw new Error('정적 색인 HTTP '+response.status);
    return response.json();
  });
  staticIndexPromise=getIndex('default').then(data=>data && Number.isFinite(data.verifiedAt) && Date.now()-data.verifiedAt<=CFG.staticIndexMaxAge?data:getIndex('no-cache')).then(data=>{
    const now=Date.now();
    if(data.schema!==1 || data.format!=='rows-v1' || data.scope!=='public' || data.complete!==true || typeof data.revision!=='string' || !data.revision || !Number.isFinite(data.verifiedAt) || data.verifiedAt>now+600000 || now-data.verifiedAt>CFG.staticIndexMaxAge || !Array.isArray(data.rows) || data.count!==data.rows.length || !data.count)throw new Error('정적 색인 검증 실패');
    const seen=new Set(),products=[],texts=[];
    for(const row of data.rows){
      if(!Array.isArray(row) || row.length<6)throw new Error('정적 색인 행 오류');
      const product={idx:String(row[0]),href:String(row[1]),title:String(row[2]),price:String(row[3]),image:String(row[4]),cardText:String(row[5])};
      if(!/^\d+$/.test(product.idx) || seen.has(product.idx) || !product.title)throw new Error('정적 색인 상품 오류');
      const href=new URL(product.href,location.origin);
      if(href.origin!==location.origin || href.searchParams.get('idx')!==product.idx || CFG.privatePathIds.has(getPathId(href.href)))throw new Error('정적 색인 경로 오류');
      seen.add(product.idx);products.push(product);texts.push(normalize(product.title+' '+product.cardText));
    }
    return {revision:data.revision,verifiedAt:data.verifiedAt,count:products.length,products,texts,loadMs:Date.now()-started};
  }).catch(error=>{staticIndexPromise=null;throw error;});
  return staticIndexPromise;
}
async function staticIndexSearch(query,signal){
  const index=await Promise.race([loadStaticIndex(),new Promise((_,reject)=>{
    const t=setTimeout(()=>reject(new Error('정적 색인 시간 초과')),8000);
    signal.addEventListener('abort',()=>{clearTimeout(t);reject(abortError());},{once:true});
  })]);
  if(signal.aborted)throw abortError();
  const started=performance.now(),words=tokenize(query),products=[];
  if(!words.length)return null;
  for(let i=0;i<index.products.length;i++){
    const text=index.texts[i];
    if(words.every(word=>text.indexOf(word.normalized)!==-1))products.push(index.products[i]);
  }
  return {schema:1,scope:'public',strategy:'static-public-index',complete:true,query:clean(query),revision:index.revision,verifiedAt:index.verifiedAt,catalogCount:index.count,count:products.length,products,serverMs:Math.round(performance.now()-started)};
}
try{loadStaticIndex().catch(()=>{});}catch(e){}

/* MEMBER (등업) CACHE (v19.4) — restricted listings read with the signed-in
   등업 user's own session and kept only in that browser (IndexedDB). */
const RC_DB='veroki-search-member',RC_STORE='cache',RC_KEY='restricted-v1';
let restrictedMem=null,restrictedBuild=null;
function rcOpen(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(RC_DB,1);
    req.onupgradeneeded=()=>req.result.createObjectStore(RC_STORE);
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
}
async function rcTx(mode,fn){
  const db=await rcOpen();
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction(RC_STORE,mode);const r=fn(tx.objectStore(RC_STORE));tx.oncomplete=()=>resolve(r&&r.result);tx.onerror=()=>reject(tx.error);});}
  finally{db.close();}
}
function clearRestrictedCache(){
  restrictedMem=null;
  try{rcTx('readwrite',s=>s.delete(RC_KEY)).catch(()=>{});}catch(e){}
}
function prepareRestricted(data){
  if(!data || data.v!==1 || !Array.isArray(data.rows) || data.count!==data.rows.length || !Number.isFinite(data.builtAt))return null;
  return {builtAt:data.builtAt,count:data.count,products:data.rows.map(r=>({idx:r[0],href:r[1],title:r[2],price:r[3],image:r[4],cardText:r[2]+' '+r[3]})),texts:data.rows.map(r=>normalize(r[2]+' '+r[3]))};
}
async function readRestrictedCache(){
  if(restrictedMem)return restrictedMem;
  try{restrictedMem=prepareRestricted(await rcTx('readonly',s=>s.get(RC_KEY)));}catch(e){restrictedMem=null;}
  return restrictedMem;
}
const rcDecoder=document.createElement('textarea');
function rcDecode(value){rcDecoder.innerHTML=value;return rcDecoder.value;}
function buildRestrictedCache(){
  if(restrictedBuild)return restrictedBuild;
  restrictedBuild=(async()=>{
    const rows=new Map();
    await Promise.all(CFG.restrictedSourceMenus.map(async menu=>{
      const page=await fetch('/'+menu,{credentials:'same-origin',cache:'no-store',redirect:'follow'});
      if(!page.ok || new URL(page.url,location.origin).pathname.replace(/\/+$/,'')!=='/'+menu)throw new Error('등업 메뉴 접근 불가 '+menu);
      const html=await page.text(),call=html.match(/url\s*:\s*\(\s*['"]\/ajax\/get_shop_list_view\.cm['"]\s*\)/),at=call?call.index:-1;
      if(at<0)throw new Error('등업 메뉴 목록 형식 변경 '+menu);
      const block=html.slice(at,at+2600),field=name=>block.match(new RegExp('["\']'+name+'["\']\\s*:\\s*["\']([^"\']*)["\']'))?.[1];
      const pageCount=Number(html.match(/var\s+page_count\s*=\s*(\d+)/)?.[1]),pageSize=Number(block.match(/["']pagesize["']\s*:\s*(\d+)/)?.[1]);
      if(!field('category') || !field('widget_code') || !Number.isSafeInteger(pageCount) || !Number.isSafeInteger(pageSize) || pageSize<1)throw new Error('등업 메뉴 설정 확인 불가 '+menu);
      const q=new URLSearchParams({category:field('category'),widget_code:field('widget_code'),menu_url:field('menu_url') || '/'+menu+'/',page:'1',pagesize:String(Math.max(1,pageCount*pageSize)),sort:'recent'});
      const response=await fetch('/ajax/get_shop_list_view.cm?'+q,{credentials:'same-origin',cache:'no-store',headers:{'X-Requested-With':'XMLHttpRequest'}});
      if(!response.ok)throw new Error('등업 목록 HTTP '+response.status);
      const payload=await response.json();
      if(payload.msg!=='SUCCESS' || typeof payload.html!=='string')throw new Error('등업 목록 응답 오류 '+menu);
      let count=0;
      for(const match of payload.html.matchAll(/data-product-properties=(["'])([\s\S]*?)\1/g)){
        const d=JSON.parse(rcDecode(match[2]));const idx=String(d.idx);count++;
        if(!/^\d+$/.test(idx) || !d.name)throw new Error('등업 상품 정보 오류');
        if(!rows.has(idx))rows.set(idx,[idx,'/'+menu+'/?idx='+idx,clean(d.name),Number(d.price).toLocaleString('en-US')+'원',String(d.image_url || '')]);
      }
      if(pageCount>0 && (count<=(pageCount-1)*pageSize || count>pageCount*pageSize))throw new Error('등업 목록 전체 수 확인 불가 '+menu);
    }));
    if(!rows.size)throw new Error('등업 상품 없음');
    const data={v:1,builtAt:Date.now(),count:rows.size,rows:[...rows.values()]};
    if(!(loggedIn() && adminAllowed===true))throw new Error('등업 권한 변경');
    await rcTx('readwrite',s=>s.put(data,RC_KEY));
    restrictedMem=prepareRestricted(data);
    return restrictedMem;
  })().finally(()=>{restrictedBuild=null;});
  return restrictedBuild;
}
async function memberCacheSearch(query,signal){
  if(typeof indexedDB==='undefined')return null;
  const [pub,cache]=await Promise.all([loadStaticIndex(),readRestrictedCache()]);
  if(signal.aborted)throw abortError();
  const age=cache?Date.now()-cache.builtAt:Infinity;
  if(age>CFG.restrictedCacheFresh)buildRestrictedCache().catch(()=>{});
  if(age>CFG.restrictedCacheMaxAge)return null;
  const started=performance.now(),words=tokenize(query),found=new Map();
  if(!words.length)return null;
  const scan=(products,texts)=>{for(let i=0;i<products.length;i++){const p=products[i];if(!found.has(p.idx) && words.every(w=>texts[i].indexOf(w.normalized)!==-1))found.set(p.idx,p);}};
  scan(pub.products,pub.texts);scan(cache.products,cache.texts);
  const products=[...found.values()];
  return {schema:1,scope:'admin',strategy:'static-public+member-cache',complete:true,query:clean(query),revision:pub.revision,verifiedAt:Math.min(pub.verifiedAt,cache.builtAt),catalogCount:pub.count+cache.count,count:products.length,products,serverMs:Math.round(performance.now()-started)};
}

async function sharedIndexSearch(query,signal,preparation){
  const scope=cacheScope();
  if(scope==='admin' && loggedIn() && adminAllowed===true){
    try{const member=await memberCacheSearch(query,signal);if(member)return member;}
    catch(error){if(signal.aborted)throw error;if(activeReport)activeReport.warnings.push('등업 캐시를 이용하지 못했습니다: '+error.message);}
  }else clearRestrictedCache();
  if(scope!=='admin'){
    try{const local=await staticIndexSearch(query,signal);if(local)return local;}
    catch(error){if(signal.aborted)throw error;if(activeReport)activeReport.warnings.push('정적 색인을 이용하지 못했습니다: '+error.message);}
  }
  if(scope==='member')return null;
  const isAdmin=scope==='admin' && loggedIn() && adminAllowed===true;
  const base=new URL(isAdmin?CFG.memberIndexApi:CFG.indexApi);
  if(base.protocol!=='https:' || isAdmin && base.hostname!=='search.verokimall.shop')return null;
  const url=new URL(isAdmin?'/v1/member-search':'/v1/search',base);url.searchParams.set('q',query);
  const request=new AbortController(),cancel=()=>request.abort();
  signal.addEventListener('abort',cancel,{once:true});
  const timeout=setTimeout(cancel,isAdmin?12000:5000);
  try{
    let response;
    if(isAdmin)response=await memberProofSearch(query,base,request.signal,preparation);
    else{networkRequestCount++;response=await fetch(url,{credentials:'omit',cache:'no-store',signal:request.signal});}
    if(isAdmin && response.status===401){adminAllowed=false;resultCache.clear();sourceCache.clear();detailCache.clear();throw new Error('등업 권한을 다시 확인해 주세요');}
    if(!response.ok)throw new Error('색인 서비스 HTTP '+response.status);
    if(new URL(response.url || url).origin!==base.origin)throw new Error('색인 주소 변경');
    const data=await response.json();
    const sameQuery=JSON.stringify(tokenize(data.query || '').map(w=>w.normalized))===JSON.stringify(tokenize(query).map(w=>w.normalized));
    if(data.schema!==1 || data.scope!==(isAdmin?'admin':'public') || data.complete!==true || !sameQuery || typeof data.revision!=='string' || !data.revision || !Number.isFinite(data.verifiedAt) || data.verifiedAt>Date.now()+60000 || Date.now()-data.verifiedAt>7200000 || !Array.isArray(data.products) || data.count!==data.products.length)throw new Error('전체 검색 색인을 확인하지 못했습니다');
    const seen=new Set();
    for(const product of data.products){
      if(!product || !/^\d+$/.test(product.idx) || seen.has(product.idx) || typeof product.title!=='string' || !product.title || typeof product.cardText!=='string')throw new Error('상품 정보 검증 실패');
      const href=new URL(product.href,location.origin);
      if(href.origin!==location.origin || href.searchParams.get('idx')!==product.idx || (!isAdmin && CFG.privatePathIds.has(getPathId(href.href))))throw new Error('상품 경로 검증 실패');
      seen.add(product.idx);
    }
    return data;
  }finally{clearTimeout(timeout);signal.removeEventListener('abort',cancel);}
}

async function runSearch(reason){
  const thisRun=++runId;
  controller?.abort();controller=new AbortController();
  const signal=controller.signal;
  const query=getKeyword(),words=tokenize(query),sort=currentSort(),delivery=deliveryMode();
  if(!words.length)return;
  const requestBaseline=reason==='initial'?0:networkRequestCount;
  const report={query,sort,delivery,version:CFG.version,startedAt:reason==='initial'?SEARCH_BOOT_STARTED_AT:Date.now(),sources:[],probes:[],issues:[],warnings:[],candidates:0,detailTargets:0,detailChecks:0,matches:0,complete:false,cached:false,strategy:''};
  activeReport=report;
  const isCurrent=()=>thisRun===runId && !signal.aborted;
  const compare=(a,b)=>{
    const price=p=>Number(String(p.price || '').replace(/[^\d]/g,''));
    if(sort==='price_asc' || sort==='low_price_desc')return price(a.product)-price(b.product) || Number(b.product.idx)-Number(a.product.idx);
    if(sort==='price_desc' || sort==='high_price_desc')return price(b.product)-price(a.product) || Number(b.product.idx)-Number(a.product.idx);
    if(sort==='regdate_desc' || sort==='time_desc')return Number(b.product.idx)-Number(a.product.idx);
    return score(b,words)-score(a,words) || Number(b.product.idx)-Number(a.product.idx);
  };
  const publish=items=>{
    if(!isCurrent())return;
    const selected=items.filter(i=>!isPrivate(i.product) && deliveryMatches(i.product)).sort(compare);
    report.matches=selected.length;report.finishedAt=Date.now();
    report.requests=networkRequestCount-requestBaseline;
    renderResults(selected.map(i=>i.product),1);renderSearchStatus(report,false);
    const area=resultArea();
    if(area){area.dataset.verokiSearchMs=String(report.finishedAt-report.startedAt);area.dataset.verokiSearchRequests=String(report.requests);area.dataset.verokiSearchCached=String(report.cached);area.dataset.verokiSearchComplete=String(report.complete);area.dataset.verokiSearchVersion=report.version;area.dataset.verokiSearchStrategy=report.strategy;area.dataset.verokiSearchRevision=report.revision || '';area.dataset.verokiSearchServerMs=String(report.serverMs ?? '');area.dataset.verokiSearchSources=JSON.stringify(report.sources);area.dataset.verokiSearchWarnings=JSON.stringify(report.warnings);}
  };
  const candidateMap=new Map(),finalMap=new Map();
  let progressAt=0;
  const progress=()=>{
    if(!isCurrent() || report.finishedAt)return;
    report.candidates=candidateMap.size;
    if(Date.now()-progressAt>200){progressAt=Date.now();renderSearchStatus(report,true);}
  };
  const confirmDirect=()=>{
    for(const [idx,item] of candidateMap)if(!isPrivate(item.product) && matchesAll(item.product.title+' '+item.product.cardText,words))finalMap.set(idx,item);
  };
  try{
    const preparation=loggedIn()?prepareMemberProof(new URL(CFG.memberIndexApi),signal).catch(error=>({error})):null;
    adminAllowed=await checkAccess();if(!isCurrent())return;
    const key=JSON.stringify(words.map(w=>w.normalized))+'|'+cacheScope();
    const cached=resultCache.get(key);
    if(cached && (reason==='delivery' || reason==='sort' || Date.now()-cached.time<60000)){
      Object.assign(report,{cached:true,complete:true,candidates:cached.candidates,sources:cached.sources,strategy:'cached-result'});publish(cached.items);return;
    }
    renderLoading();renderSearchStatus(report,true);
    try{
      const shared=await sharedIndexSearch(query,signal,preparation);
      if(!isCurrent())return;
      if(shared){
        const items=shared.products.map(product=>({product,sources:new Set(['shared-index'])}));
        Object.assign(report,{complete:true,strategy:shared.strategy||(shared.scope==='admin'?'shared-member-index':'shared-public-index'),candidates:shared.catalogCount,revision:shared.revision,indexVerifiedAt:shared.verifiedAt,serverMs:shared.serverMs,sources:[{term:query,label:'shared-index',pages:0,products:items.length,complete:true}]});
        resultCache.set(key,{time:Date.now(),items,candidates:shared.catalogCount,sources:report.sources});saveDiskLater();
        publish(items);return;
      }
    }catch(error){
      if(signal.aborted)throw error;
      report.warnings.push('공용 색인을 이용하지 못해 기존 검색으로 확인합니다: '+error.message);
    }
    const specs=sourceSpecs(query,words);
    const groups=words.map((word,index)=>{
      const terms=new Set([normalize(word.raw),normalize(relaxedTerm(word))]);
      const matching=specs.filter(spec=>terms.has(normalize(spec.term)));
      const raw=matching.find(spec=>spec.term===word.raw);
      const preferred=matching.find(spec=>spec.term===relaxedTerm(word)) || raw;
      return {index,word,raw,preferred,specs:[preferred]};
    });
    const probes=await mapLimit(specs,3,spec=>probeSource(spec,signal,report));
    if(!isCurrent())return;
    probes.forEach(p=>p.products.forEach(product=>addCandidate(candidateMap,product,p.label)));
    const byTerm=new Map(probes.map(p=>[p.term,p]));
    const collectGroup=async group=>{
      await mapLimit(group.specs.filter(spec=>!report.sources.some(s=>s.label===spec.label && s.complete)),2,spec=>collectSource(spec,candidateMap,signal,report,progress));
      const wide=readSource(group.preferred.term);
      if(wide && group.raw && group.raw.term!==group.preferred.term){
        const ids=new Set(wide.products.map(p=>p.idx));
        const rawProbe=byTerm.get(group.raw.term);
        // A substring prefix is a superset in the site's single-word index.
        // If observed raw hits violate this property, retain the full raw
        // source too instead of trusting the optimization.
        if(rawProbe?.products.some(p=>!isPrivate(p) && !ids.has(p.idx))){
          if(!group.specs.some(s=>s.term===group.raw.term))group.specs.push(group.raw);
          if(!report.sources.some(s=>s.label===group.raw.label && s.complete))await collectSource(group.raw,candidateMap,signal,report,progress);
          report.warnings.push('원래 검색어의 추가 후보를 보강했습니다: '+group.raw.term);
        }
      }
    };
    const estimate=group=>group.specs.reduce((cost,spec)=>{
      const p=byTerm.get(spec.term);
      if(p?.complete)return cost;
      if(p?.failed)return Infinity;
      return cost+Math.max(1,(p?.maxPage || 1));
    },0);
    const ordered=groups.slice().sort((a,b)=>estimate(a)-estimate(b) || b.word.normalized.length-a.word.normalized.length || a.index-b.index);
    let anchor=null;
    for(const group of ordered){
      if(group.specs.some(spec=>byTerm.get(spec.term)?.failed)){
        report.warnings.push('초기 조회에 실패한 검색어 그룹: '+group.word.raw);continue;
      }
      const before=report.issues.length;
      await collectGroup(group);
      if(!isCurrent())return;
      if(group.specs.every(spec=>report.sources.some(s=>s.label===spec.label && s.complete))){anchor=group;break;}
      report.warnings.push(...report.issues.splice(before));
    }
    if(!anchor){report.issues.push('완료된 검색어 인덱스를 확보하지 못했습니다');confirmDirect();publish(Array.from(finalMap.values()));return;}
    report.anchor=anchor.word.raw;
    confirmDirect();progress();
    const anchorLabels=new Set(anchor.specs.map(s=>s.label));
    let eligible=Array.from(candidateMap.values()).filter(item=>!isPrivate(item.product) && !finalMap.has(item.product.idx) && Array.from(item.sources).some(label=>anchorLabels.has(label)));
    const missingDetail=eligible.filter(item=>{
      const key=cacheScope()+'|'+item.product.idx+'|'+item.product.href;
      const entry=detailCache.get(key);return !entry || Date.now()-entry.time>=CFG.detailCacheTtl;
    }).length;
    const remainingGroups=groups.filter(g=>g!==anchor);
    const extraSpecs=Array.from(new Map(remainingGroups.flatMap(g=>g.specs).map(s=>[s.term,s])).values()).filter(spec=>!report.sources.some(s=>s.label===spec.label) && !byTerm.get(spec.term)?.failed);
    const extraCost=extraSpecs.reduce((cost,spec)=>{
      const p=byTerm.get(spec.term);return cost+(readSource(spec.term)?0:Math.max(1,p?.maxPage || 1));
    },0);
    // Both routes preserve recall under the same single-word index contract
    // used by v13.1. The anchor group is always collected to completion.
    // No page, candidate, or detail count is ever used as a truncation limit.
    if(extraSpecs.length && extraCost<missingDetail){
      report.strategy='complete-word-intersection';
      await mapLimit(remainingGroups.filter(group=>group.specs.some(spec=>extraSpecs.some(extra=>extra.term===spec.term))),3,collectGroup);
      if(!isCurrent())return;
      confirmDirect();
      eligible=Array.from(candidateMap.values()).filter(item=>!isPrivate(item.product) && !finalMap.has(item.product.idx) && Array.from(item.sources).some(label=>anchorLabels.has(label)));
    }else report.strategy='complete-anchor-and-detail';
    // Negative membership is evidence only for an entirely collected group.
    const completeGroups=groups.filter(group=>group.specs.every(spec=>report.sources.some(s=>s.label===spec.label && s.complete)));
    eligible=eligible.filter(item=>completeGroups.every(group=>group.specs.some(spec=>item.sources.has(spec.label))));
    // Failed optional lookup never excludes an anchor candidate. A complete
    // anchor plus successful detail checks still covers the indexed scope.
    if(report.issues.length)report.warnings.push(...report.issues.splice(0));
    eligible.sort(compare);report.detailTargets=eligible.length;
    await mapLimit(eligible,4,async item=>{
      try{
        const detail=await getDetail(item.product,signal);
        if(matchesAll(item.product.title+' '+item.product.cardText+' '+detail,words))finalMap.set(item.product.idx,item);
      }catch(error){
        if(signal.aborted || error.rateLimited)throw error;
        report.issues.push('상품 '+item.product.idx+': '+error.message);
      }
      report.detailChecks++;progress();
    });
    if(!isCurrent())return;
    report.complete=report.issues.length===0;
    const items=Array.from(finalMap.values());
    if(report.complete){resultCache.set(key,{time:Date.now(),items,candidates:candidateMap.size,sources:report.sources});saveDiskLater();}
    publish(items);
  }catch(error){
    if(!isCurrent())return;
    confirmDirect();report.issues.push(error.message || '검색 요청 실패');publish(Array.from(finalMap.values()));controller.abort();
  }
}

function renderSearchStatus(report,pending){
  const area=resultArea();
  if(!area || report!==activeReport) return;
  let node=area.querySelector('.veroki-search-status');
  if(!node){ node=document.createElement('div'); node.className='veroki-search-status'; node.setAttribute('role','status'); area.prepend(node); }
  node.style.cssText='padding:10px 0;color:#777;font-size:13px;line-height:1.5';
  node.textContent=pending ? (serverPauseUntil>Date.now() ? '요청이 많아 잠시 대기 중입니다.' : (report.detailTargets ? '상품 정보 확인 중입니다. '+report.detailChecks+'/'+report.detailTargets : '검색 결과를 확인 중입니다. '+report.candidates+'개 상품 확인')) : report.complete ? '' : '일부 상품 정보를 확인하지 못했습니다. 잠시 후 다시 검색해 주세요. ('+report.issues.length+'건)';
}


/* =========================================================
   SAME-PAGE RE-SEARCH
   ========================================================= */

/*
 URL만 현재 검색어로 갱신.
 페이지 reload 없음.
*/
function syncUrl(){

  const query=
    getKeyword();


  if(!query){

    return;

  }


  const url=
    new URL(
      location.href
    );


  url.pathname=
    '/search';


  url.searchParams.set(
    'type',
    'shopping'
  );


  url.searchParams.set(
    'sort',
    currentSort()
  );


  url.searchParams.set(
    'keyword',
    query
  );


  url.searchParams.delete(
    'page'
  );


  history.replaceState(
    null,
    '',
    url.pathname+
    '?'+
    url.searchParams.toString()
  );

}


/*
 keydown + keyup + submit이
 동시에 들어오는 것을 250ms 내에서 1회로 합침.
*/
function launchSearch(reason){

  const query=
    getKeyword();


  if(!query){

    return;

  }


  const now=
    Date.now();


  const key=
    query+
    '|'+
    currentSort()+
    '|'+
    deliveryMode();


  if(
    key===lastLaunchKey &&
    now-lastLaunchAt<250
  ){

    return;

  }


  lastLaunchKey=
    key;


  lastLaunchAt=
    now;


  syncUrl();


  runSearch(reason);

}


function queueSearch(
  reason,
  delay
){

  clearTimeout(
    searchQueueTimer
  );


  searchQueueTimer=
    setTimeout(
      function(){ launchSearch(reason); },
      delay||0
    );

}


function isSearchInput(target){

  return !!(
    target &&
    target.matches &&
    target.matches(
      '.search_widget_v2 .sw2-search-input[name="keyword"]'
    )
  );

}


/*
 아임웹 기본 SITE_SEARCH 이벤트 제거.

 document 이벤트 위임을 사용하므로
 input이 AJAX로 교체되어도 재바인딩 필요 없음.
*/
function neutralizeNative(){
  document.querySelector('.search_widget_v2 .sw2-sort-select')?.removeAttribute('onchange');

  const input=
    getInput();


  if(input){

    if(
      input.hasAttribute(
        'onkeyup'
      )
    ){

      input.removeAttribute(
        'onkeyup'
      );

    }


    if(
      input.hasAttribute(
        'onkeydown'
      )
    ){

      input.removeAttribute(
        'onkeydown'
      );

    }

  }


  const icon=
    document.querySelector(
      '.search_widget_v2 .sw2-search-icon'
    );


  if(
    icon &&
    icon.hasAttribute(
      'onclick'
    )
  ){

    icon.removeAttribute(
      'onclick'
    );

  }

}


/*
 직접 input에 listener를 붙이지 않음.

 document capture 방식이므로
 검색결과가 바뀌거나 input DOM이 교체돼도 계속 작동.
*/
function installDelegatedHandlers(){

  /*
   PC Enter
   한글 조합 중 Enter는 compositionend에서 처리.
  */

  document.addEventListener(
    'keydown',

    function(event){

      if(
        !isSearchInput(
          event.target
        )
        ||
        event.key!=='Enter'
      ){

        return;

      }


      if(
        event.isComposing ||
        event.keyCode===229
      ){

        imeEnterPending=true;

        return;

      }


      event.preventDefault();

      event.stopPropagation();

      event.stopImmediatePropagation();


      imeEnterPending=false;


      queueSearch(
        'keydown',
        0
      );

    },

    true
  );


  /*
   한국어 IME Enter 대응
  */

  document.addEventListener(
    'compositionend',

    function(event){

      if(
        !isSearchInput(
          event.target
        )
        ||
        !imeEnterPending
      ){

        return;

      }


      imeEnterPending=false;


      /*
       브라우저가 최종 한글값을
       input.value에 반영한 다음 실행.
      */

      queueSearch(
        'compositionend',
        25
      );

    },

    true
  );


  /*
   keydown을 놓치는 브라우저 fallback.
   250ms 중복방지 때문에 이중검색되지 않음.
  */

  document.addEventListener(
    'keyup',

    function(event){

      if(
        !isSearchInput(
          event.target
        )
        ||
        event.key!=='Enter'
        ||
        event.isComposing
      ){

        return;

      }


      event.preventDefault();

      event.stopPropagation();

      event.stopImmediatePropagation();


      queueSearch(
        'keyup',
        0
      );

    },

    true
  );


  /*
   돋보기
  */

  document.addEventListener(
    'click',

    function(event){

      const icon=
        event.target &&
        event.target.closest
        ?
        event.target.closest(
          '.search_widget_v2 .sw2-search-icon'
        )
        :
        null;


      if(!icon){

        return;

      }


      event.preventDefault();

      event.stopPropagation();

      event.stopImmediatePropagation();


      queueSearch(
        'click',
        0
      );

    },

    true
  );


  /*
   모바일 키보드 검색 / form submit
  */

  document.addEventListener(
    'submit',

    function(event){

      const form=
        event.target;


      if(
        !form ||
        !form.matches ||
        !form.matches(
          '.search_widget_v2 #s_form'
        )
      ){

        return;

      }


      event.preventDefault();

      event.stopPropagation();

      event.stopImmediatePropagation();


      queueSearch(
        'submit',
        imeEnterPending
        ?
        30
        :
        0
      );

    },

    true
  );

}


/* =========================================================
   INIT
   ========================================================= */

function init(){

  makeDelivery();
  document.addEventListener('change',function(event){
    if(event.target.matches?.('.search_widget_v2 .sw2-sort-select')){
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();queueSearch('sort',0);
    }
  },true);


  /*
   아임웹 inline 검색 제거
  */

  neutralizeNative();


  /*
   이벤트 위임은 딱 한 번
  */

  installDelegatedHandlers();


  /*
   권한 미리 확인
  */

  checkAccess()
    .catch(function(){});


  /*
   처음 검색 페이지 진입
  */

  if(getKeyword()){

    queueSearch(
      'initial',
      0
    );

  }


  /*
   아임웹이 검색 widget DOM을 다시 그리면
   inline 이벤트만 다시 제거하고
   배송 필터 위치만 복구.

   검색 이벤트 자체는 document에 있으므로
   재바인딩하지 않음.
  */

  const widget=
    document.querySelector(
      '.search_widget_v2'
    );


  if(widget){

    let timer=null;


    const observer=
      new MutationObserver(
        function(){

          clearTimeout(
            timer
          );


          timer=
            setTimeout(
              function(){

                makeDelivery();

                neutralizeNative();
                if(publishedProducts && !document.getElementById('veroki-search-results')){
                  renderResults(publishedProducts,publishedPage);
                  if(activeReport) renderSearchStatus(activeReport,false);
                }

              },
              40
            );

        }
      );


    observer.observe(
      widget,
      {

        childList:true,

        subtree:true,

        attributes:true,

        attributeFilter:[
          'onkeyup',
          'onkeydown',
          'onchange',
          'onclick'
        ]

      }
    );

  }

}


/* =========================================================
   PUBLIC
   ========================================================= */

window.VEROKI_SEARCH_SYSTEM={

  version:
    CFG.version,

  search:
    function(){

      queueSearch(
        'api',
        0
      );

  },

  diagnostics: function(){ return activeReport ? JSON.parse(JSON.stringify(activeReport)) : null; },

  clearCaches:
    function(){

      clearTimeout(diskTimer);
      sourceCache.clear();
      try{sessionStorage.removeItem(DISK_KEY);}catch(e){}
      resultCache.clear();
      searchCache.clear();

      detailCache.clear();

  }

};


/* =========================================================
   START
   ========================================================= */

if(
  document.readyState==='loading'
){

  document.addEventListener(
    'DOMContentLoaded',
    init,
    {
      once:true
    }
  );

}else{

  init();

}

})();
