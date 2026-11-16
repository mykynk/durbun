// Generated from sdks/js/webview/bridge.ts by sdks/js/scripts/gen-webview-bridge.mjs. Do not edit.
package dev.durbun.internal

/** The script `DurbunWebView` injects into a web view: reports fetch, XMLHttpRequest and console calls. */
internal object WebViewBridgeScript {
    const val SOURCE: String =
        "\"use strict\";(()=>{var l={maxBodyBytes:65536,maxConsoleChars:16384,maxUrlChars:8192,maxHeaders:100,m" +
        "axHeaderChars:16384,maxInFlight:100,ratePerSecond:50,burst:200,bodyTimeoutMs:3e4,maxDepth:4,maxKeys:" +
        "50},M=typeof Symbol==\"function\"?Symbol.for(\"durbun.webviewBridge\"):\"__durbunWebViewBridge\";function " +
        "_(e){try{let n=e.webkit&&e.webkit.messageHandlers&&e.webkit.messageHandlers.__durbun;if(n&&typeof n." +
        "postMessage==\"function\")return t=>n.postMessage(t)}catch(n){}try{let n=e.__durbun;if(n&&typeof n.pos" +
        "t==\"function\")return t=>n.post(t)}catch(n){}return null}function q(e){try{let n=_(e);return n?K(e,n)" +
        ":!1}catch(n){return!1}}function K(e,n){if(!e||e[M])return!1;try{Object.defineProperty(e,M,{value:!0," +
        "enumerable:!1,configurable:!1,writable:!1})}catch(y){return!1}let t=JSON.stringify.bind(JSON),r=Date" +
        ".now.bind(Date),o=e.performance&&typeof e.performance.now==\"function\"?e.performance:null,s=o?()=>o.n" +
        "ow():r,c=\"w\"+Math.floor(Math.random()*2147483647).toString(36)+\"-\",d=0,a=0,i=l.burst,u=s(),f=0,g=!1," +
        "k=()=>{let y=s();return i=Math.min(l.burst,i+(y-u)*l.ratePerSecond/1e3),u=y,i<1?(f++,!1):(i-=1,!0)}," +
        "m={scope:e,stringify:t,now:s,clock:r,send(y,p){if(g)return!1;g=!0;try{return!p&&!k()?!1:(f>0&&i>=1&&" +
        "(i-=1,n(t({v:1,t:\"dropped\",count:f})),f=0),y.v=1,n(t(y)),!0)}catch(B){return!1}finally{g=!1}},begin(" +
        "y,p,B,A,N){if(a>=l.maxInFlight)return null;let O={id:c+ ++d,started:s(),method:p},\$={t:\"req\",id:O.id" +
        ",api:y,ts:r(),method:p,url:B,headers:A};return N&&(\$.body=N),m.send(\$)?(a++,O):null},end(){a>0&&a--}" +
        "},h=!1;return h=G(m)||h,h=Q(m)||h,h=re(m)||h,oe(m),h}function C(e,n,t){try{let r=e[n];if(typeof r!=\"" +
        "function\")return!1;let o=Object.getOwnPropertyDescriptor(e,n),s=t(r);return o&&!o.configurable&&!o.w" +
        "ritable?!1:(o&&\"value\"in o?Object.defineProperty(e,n,{value:s,writable:o.writable,enumerable:o.enume" +
        "rable,configurable:o.configurable}):e[n]=s,!0)}catch(r){return!1}}function b(e,n){return e.length>n?" +
        "e.slice(0,n):e}function D(e,n){let t=n;try{let r=e.document&&e.document.baseURI||e.location&&e.locat" +
        "ion.href||void 0;t=new e.URL(n,r).href}catch(r){}return/^https?:/i.test(t)?b(t,l.maxUrlChars):null}f" +
        "unction R(e,n,t,r){if(e.length>=l.maxHeaders)return;let o=String(t),s=String(r);o.length+s.length>n." +
        "left||(n.left-=o.length+s.length,e.push([o,s]))}function z(e){let n=[],t={left:l.maxHeaderChars};if(" +
        "!e)return n;try{if(typeof e.forEach==\"function\"&&!Array.isArray(e))e.forEach((r,o)=>R(n,t,o,r));else" +
        " if(Array.isArray(e))for(let r of e)r&&r.length>=2&&R(n,t,r[0],r[1]);else if(typeof e==\"object\")for(" +
        "let r of Object.keys(e))R(n,t,r,e[r])}catch(r){}return n}function S(e,n){let t=n.toLowerCase();for(l" +
        "et r of e)if(r[0].toLowerCase()===t)return r[1]}function X(e){if(!e)return!1;let n=e.toLowerCase();r" +
        "eturn n.startsWith(\"text/\")||/[/+](json|xml|javascript|ecmascript|graphql|x-www-form-urlencoded|x-nd" +
        "json|yaml|csv)\\b/.test(n)}function P(e){let n=0;for(let t=0;t<e.length;t++){let r=e.charCodeAt(t);r<" +
        "128?n+=1:r<2048?n+=2:r>=55296&&r<=56319?(n+=4,t++):n+=3}return n}function T(e,n){let t=e.length>l.ma" +
        "xBodyBytes,r=t?e.slice(0,l.maxBodyBytes):e,o=n!==void 0&&n>=0?n:P(e),s={encoding:\"utf8\",data:r,size:" +
        "Math.max(o,P(r))};return t&&(s.truncated=!0),s}function W(e,n){let t=\"\";for(let r=0;r<n.length;r+=32" +
        "768)t+=String.fromCharCode.apply(null,Array.prototype.slice.call(n.subarray(r,r+32768)));return e.bt" +
        "oa(t)}function V(e,n){try{return typeof e.TextDecoder!=\"function\"?null:new e.TextDecoder(\"utf-8\").de" +
        "code(n)}catch(t){return null}}function E(e,n,t,r,o){if(X(o)){let c=V(e,n);if(c!==null){let d={encodi" +
        "ng:\"utf8\",data:c,size:t};return r&&(d.truncated=!0),d}}let s={encoding:\"base64\",data:W(e,n),size:t};" +
        "return r&&(s.truncated=!0),s}function w(e){return e>0?{encoding:\"utf8\",data:\"\",size:e,truncated:!0}:" +
        "void 0}function F(e,n,t){try{if(n==null)return;if(typeof n==\"string\")return T(n);if(typeof e.URLSear" +
        "chParams==\"function\"&&n instanceof e.URLSearchParams)return T(String(n));if(typeof e.Blob==\"function" +
        "\"&&n instanceof e.Blob)return w(n.size);let r=null;if(typeof ArrayBuffer!=\"undefined\"&&n instanceof " +
        "ArrayBuffer?r=new Uint8Array(n):typeof ArrayBuffer!=\"undefined\"&&ArrayBuffer.isView(n)&&(r=new Uint8" +
        "Array(n.buffer,n.byteOffset,n.byteLength)),r){let o=r.length>l.maxBodyBytes?r.subarray(0,l.maxBodyBy" +
        "tes):r;return E(e,o,r.length,o.length<r.length,t)}return}catch(r){return}}function U(e){try{if(e&&ty" +
        "peof e==\"object\"){let n=e.name?String(e.name):\"Error\";return b(e.message?`\${n}: \${String(e.message)}" +
        "`:n,1024)}return b(String(e),1024)}catch(n){return\"Error\"}}function G(e){let n=e.scope;return C(n,\"f" +
        "etch\",t=>function(o,s){let c=null,d=null;try{let u=n.Request,f=typeof u==\"function\"&&o instanceof u," +
        "g=f?o.url:o&&typeof o==\"object\"&&\"href\"in o?o.href:String(o),k=D(n,String(g));if(k){let m=String(s&&" +
        "s.method||(f?o.method:\"GET\")).toUpperCase(),h=z(s&&s.headers!==void 0?s.headers:f?o.headers:void 0)," +
        "y;if(s&&s.body!==void 0)y=F(n,s.body,S(h,\"content-type\"));else if(f&&o.body&&!o.bodyUsed&&m!==\"GET\"&" +
        "&m!==\"HEAD\"){let p=o.clone(),B=S(h,\"content-type\");d=()=>{I(n,p).then(A=>{c&&A&&e.send({t:\"reqbody\"," +
        "id:c.id,body:E(n,A.kept,A.size,A.truncated,B)},!0)},()=>{})}}c=e.begin(\"fetch\",m,k,h,y),c&&d&&d()}}c" +
        "atch(u){c=null}if(!c)return t.apply(this,arguments);let a=c,i;try{i=t.apply(this,arguments)}catch(u)" +
        "{throw e.send({t:\"err\",id:a.id,ts:e.clock(),error:U(u)},!0),e.end(a),u}try{return i.then(u=>{try{J(e" +
        ",a,u)}catch(f){e.end(a)}return u},u=>{try{let f={t:\"err\",id:a.id,ts:e.clock(),error:U(u)};u&&u.name=" +
        "==\"AbortError\"&&(f.cancelled=!0),e.send(f,!0)}catch(f){}throw e.end(a),u})}catch(u){return e.end(a)," +
        "i}})}function I(e,n){let t=n&&n.body;if(!t||typeof t.getReader!=\"function\")return!n||typeof n.arrayB" +
        "uffer!=\"function\"?Promise.resolve(null):n.arrayBuffer().then(i=>{let u=new Uint8Array(i),f=u.length>" +
        "l.maxBodyBytes?u.subarray(0,l.maxBodyBytes):u;return{kept:f,size:u.length,truncated:f.length<u.lengt" +
        "h}});let r=t.getReader(),o=[],s=0,c=0,d=i=>{let u=new Uint8Array(s),f=0;for(let g of o)u.set(g,f),f+" +
        "=g.length;return{kept:u,size:c,truncated:!i}},a=()=>r.read().then(i=>{if(i.done)return d(!0);let u=i" +
        ".value instanceof Uint8Array?i.value:new Uint8Array(i.value||[]);if(c+=u.length,s<l.maxBodyBytes){le" +
        "t f=u.subarray(0,l.maxBodyBytes-s);o.push(f),s+=f.length}if(c>l.maxBodyBytes){try{r.cancel().then(vo" +
        "id 0,()=>{})}catch(f){}return d(!1)}return a()});return a()}function J(e,n,t){let r=e.scope,o=e.now(" +
        "),s=z(t&&t.headers),c=S(s,\"content-type\"),d=Number(S(s,\"content-length\")),a=Number.isFinite(d)&&d>=0" +
        "?d:-1,i=Number(t&&t.status)||0,u=!1,f=y=>{if(u)return;u=!0;let p=e.now(),B={t:\"res\",id:n.id,ts:e.clo" +
        "ck(),status:i,statusText:b(String(t&&t.statusText||\"\"),256),headers:s,wait:Math.max(0,o-n.started),r" +
        "eceive:Math.max(0,p-o)};y&&(B.body=y),e.send(B,!0),e.end(n)},g=!!c&&/^text\\/event-stream|^applicatio" +
        "n\\/(x-)?ndjson/i.test(c);if(!t||!t.body||t.type===\"opaque\"||n.method===\"HEAD\"||i===204||i===304||g||" +
        "typeof t.clone!=\"function\"){f(a>0?w(a):void 0);return}let m;try{m=t.clone()}catch(y){f(a>0?w(a):void" +
        " 0);return}let h=r.setTimeout(()=>f(a>0?w(a):void 0),l.bodyTimeoutMs);I(r,m).then(y=>{if(r.clearTime" +
        "out(h),!y)return f(a>0?w(a):void 0);let p=y.truncated&&a>y.size?a:y.size;f(y.size>0||y.kept.length>0" +
        "?E(r,y.kept,p,y.truncated,c):void 0)},()=>{r.clearTimeout(h),f(a>0?w(a):void 0)})}function Q(e){let " +
        "n=e.scope,t=n.XMLHttpRequest;if(typeof t!=\"function\"||!t.prototype)return!1;let r=t.prototype,o=new " +
        "WeakMap,s=C(r,\"open\",c=>function(a,i){try{let u=o.get(this);u&&u.tracked&&(e.send({t:\"err\",id:u.trac" +
        "ked.id,ts:e.clock(),error:\"AbortError\",cancelled:!0},!0),e.end(u.tracked)),o.set(this,{method:String" +
        "(a).toUpperCase(),url:D(n,String(i)),headers:[],tracked:null,headersAt:0,failure:\"\",listening:u?u.li" +
        "stening:!1})}catch(u){}return c.apply(this,arguments)});return C(r,\"setRequestHeader\",c=>function(a," +
        "i){let u=c.apply(this,arguments);try{let f=o.get(this);if(f&&!f.tracked){let g=f.headers.find(k=>k[0" +
        "].toLowerCase()===String(a).toLowerCase());g?g[1]=`\${g[1]}, \${String(i)}`:R(f.headers,{left:l.maxHea" +
        "derChars},a,i)}}catch(f){}return u}),C(r,\"send\",c=>function(a){let i;try{if(i=o.get(this),i&&i.url&&" +
        "!i.tracked){i.failure=\"\",i.headersAt=0,i.listening||(i.listening=!0,Y(e,this,o));let u=i.method===\"G" +
        "ET\"||i.method===\"HEAD\"?void 0:F(n,a,S(i.headers,\"content-type\"));i.tracked=e.begin(\"xhr\",i.method,i." +
        "url,i.headers,u)}}catch(u){}try{return c.apply(this,arguments)}catch(u){let f=i&&i.tracked;throw i&&" +
        "f&&(i.tracked=null,e.send({t:\"err\",id:f.id,ts:e.clock(),error:U(u)},!0),e.end(f)),u}}),s}function Y(" +
        "e,n,t){let r=e.scope;n.addEventListener(\"readystatechange\",()=>{try{let o=t.get(n);o&&o.tracked&&!o." +
        "headersAt&&n.readyState>=2&&(o.headersAt=e.now())}catch(o){}});for(let o of[\"error\",\"abort\",\"timeout" +
        "\"])n.addEventListener(o,()=>{let s=t.get(n);s&&s.tracked&&(s.failure=o)});n.addEventListener(\"loaden" +
        "d\",()=>{let o=t.get(n);if(!o||!o.tracked)return;let s=o.tracked;o.tracked=null;try{if(o.failure){let" +
        " f={t:\"err\",id:s.id,ts:e.clock(),error:o.failure===\"timeout\"?\"Timeout\":o.failure===\"abort\"?\"AbortErr" +
        "or\":\"Network error\"};o.failure===\"abort\"&&(f.cancelled=!0),e.send(f,!0);return}let c=e.now(),d=o.hea" +
        "dersAt||c,a=Z(String(n.getAllResponseHeaders()||\"\")),i={t:\"res\",id:s.id,ts:e.clock(),status:Number(n" +
        ".status)||0,statusText:b(String(n.statusText||\"\"),256),headers:a,wait:Math.max(0,d-s.started),receiv" +
        "e:Math.max(0,c-d)},u=v(e,n,a,s.method);u&&(i.body=u),e.send(i,!0)}catch(c){}finally{e.end(s)}})}func" +
        "tion Z(e){let n=[],t={left:l.maxHeaderChars};for(let r of e.split(/\\r?\\n/)){let o=r.indexOf(\":\");o>0" +
        "&&R(n,t,r.slice(0,o).trim(),r.slice(o+1).trim())}return n}function v(e,n,t,r){let o=e.scope;if(r===\"" +
        "HEAD\")return;let s=Number(S(t,\"content-length\")),c=Number.isFinite(s)&&s>=0?s:void 0,d=n.responseTyp" +
        "e||\"\";if(d===\"\"||d===\"text\"){let a=String(n.responseText||\"\");return a.length?T(a,c):void 0}if(d===\"" +
        "json\")return n.response===null||n.response===void 0?void 0:T(e.stringify(n.response),c);if(d===\"arra" +
        "ybuffer\"&&n.response){let a=new Uint8Array(n.response),i=a.length>l.maxBodyBytes?a.subarray(0,l.maxB" +
        "odyBytes):a;return E(o,i,a.length,i.length<a.length,S(t,\"content-type\"))}return d===\"blob\"&&n.respon" +
        "se?w(Number(n.response.size)||0):c?w(c):void 0}var ee=[[\"debug\",\"debug\"],[\"log\",\"info\"],[\"info\",\"inf" +
        "o\"],[\"warn\",\"warn\"],[\"error\",\"error\"]];function j(e,n){try{if(typeof e==\"string\")return e;if(e==null" +
        "||typeof e!=\"object\")return typeof e==\"function\"?`function \${e.name||\"\"}`.trim():String(e);if(e inst" +
        "anceof Error)return`\${e.name}: \${e.message}`;let t=e;return t.nodeType===1&&t.tagName?`<\${String(t.t" +
        "agName).toLowerCase()}>`:n(L(e,0,[]))}catch(t){return Object.prototype.toString.call(e)}}function L(" +
        "e,n,t){if(e===null||typeof e!=\"object\")return typeof e==\"function\"?\"[function]\":typeof e==\"bigint\"||" +
        "typeof e==\"symbol\"||typeof e==\"number\"&&!Number.isFinite(e)?String(e):e;if(t.indexOf(e)>=0)return\"[c" +
        "ircular]\";if(n>=l.maxDepth)return Array.isArray(e)?\"[array]\":\"[object]\";if(e instanceof Error)return" +
        "`\${e.name}: \${e.message}`;t.push(e);try{if(Array.isArray(e)){let s=e.slice(0,l.maxKeys).map(c=>L(c,n" +
        "+1,t));return e.length>l.maxKeys&&s.push(`\\u2026 \${e.length-l.maxKeys} more`),s}let r={},o=Object.ke" +
        "ys(e);for(let s of o.slice(0,l.maxKeys))r[s]=L(e[s],n+1,t);return o.length>l.maxKeys&&(r[\"\\u2026\"]=`" +
        "\${o.length-l.maxKeys} more keys`),r}finally{t.pop()}}function ne(e,n=JSON.stringify){let t=e.slice()" +
        ",r=\"\";typeof t[0]==\"string\"&&/%[sdifoOc%]/.test(t[0])&&(r=t.shift().replace(/%([sdifoOc%])/g,(c,d)=>" +
        "{if(d===\"%\")return\"%\";if(!t.length)return c;let a=t.shift();return d===\"c\"?\"\":d===\"d\"||d===\"i\"?Strin" +
        "g(parseInt(String(a),10)):d===\"f\"?String(parseFloat(String(a))):j(a,n)}));let o=t.map(s=>j(s,n));ret" +
        "urn r&&o.unshift(r),o.join(\" \")}function x(e){if(!(e instanceof Error))return;let n={type:b(String(e" +
        ".name||\"Error\"),256),message:b(String(e.message||\"\"),4096)};return e.stack&&(n.stack=b(String(e.stac" +
        "k),32*1024)),n}function te(e){try{return b(String(e.location&&e.location.href),2048)}catch(n){return" +
        "\"\"}}function H(e,n,t,r){let o={t:\"log\",ts:e.clock(),level:n,message:b(t,l.maxConsoleChars),page:te(e" +
        ".scope)};r&&(o.error=r),e.send(o)}function re(e){let n=e.scope.console;if(!n||typeof n!=\"object\")ret" +
        "urn!1;let t=!1;for(let[r,o]of ee)t=C(n,r,s=>function(...d){try{let a=d.find(i=>i instanceof Error);H" +
        "(e,o,ne(d,e.stringify),x(a))}catch(a){}return s.apply(this,d)})||t;return t}function oe(e){let n=e.s" +
        "cope;if(typeof n.addEventListener==\"function\")try{n.addEventListener(\"error\",t=>{try{if(!t||typeof t" +
        ".message!=\"string\")return;let r=t.filename?` (\${t.filename}:\${t.lineno||0}:\${t.colno||0})`:\"\";H(e,\"e" +
        "rror\",`Uncaught \${t.message}\${r}`,x(t.error))}catch(r){}}),n.addEventListener(\"unhandledrejection\",t" +
        "=>{try{let r=t?t.reason:void 0;H(e,\"error\",`Unhandled promise rejection: \${j(r,e.stringify)}`,x(r))}" +
        "catch(r){}})}catch(t){}}q(typeof window!=\"undefined\"?window:globalThis);})();"
}
