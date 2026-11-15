// Token rotation for the owned HTTP fixture control session, independent of UI.
export function rotatingToken(initial,refresh,now=Date.now){
 let session=initial,inflight;
 function expiry(value){const exp=JSON.parse(Buffer.from(value.access_token.split('.')[1],'base64url').toString()).exp;if(!Number.isFinite(exp))throw Error('Fixture token expiry unavailable');return exp*1000;}
 expiry(session);
 return async()=>{
  if(expiry(session)>now()+45000)return session.access_token;
  if(!inflight)inflight=Promise.resolve().then(()=>refresh(session.refresh_token)).then(next=>{expiry(next);session=next;return next.access_token}).finally(()=>inflight=undefined);
  return inflight;
 };
}
