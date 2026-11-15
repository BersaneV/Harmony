// Named, immutable QA requests. These caps never change product defaults.
export const profiles=Object.freeze({
 '720p30':Object.freeze({id:'720p30',width:1280,height:720,fps:30,bitrate_mbps:4,min_displayed_fps:24,min_source_fps:24}),
 '1080p60':Object.freeze({id:'1080p60',width:1920,height:1080,fps:60,bitrate_mbps:8,min_displayed_fps:54,min_source_fps:54}),
 '1440p60':Object.freeze({id:'1440p60',width:2560,height:1440,fps:60,bitrate_mbps:16,min_displayed_fps:54,min_source_fps:54}),
});
export function getProfile(id='720p30'){
 if(!Object.hasOwn(profiles,id))throw Error('Unknown fixed EXE-WAN profile');
 return profiles[id];
}
export function requestedProfile(){return getProfile(process.env.HARMONY_EXE_PROFILE||'720p30');}
