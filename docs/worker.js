importScripts('model.js');
let data;
onmessage = ({data:msg}) => {
  try {
    if(msg.kind==='demo') data=StudioModel.demo();
    if(msg.kind==='source') data=StudioModel.parseChat(msg.raw,msg.meta);
    const windows=StudioModel.features(data,msg.cfg);
    const {rows,...meta}=data;
    postMessage({meta:{...meta,count:rows.length},windows,serial:msg.serial});
  } catch(error) {postMessage({error:error.message,serial:msg.serial});}
};
