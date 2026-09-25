const r = /(\.\d*?[1-9])0+$|\.0+$/;
console.log('1.00000000'.replace(r, '$1'));
console.log('1.23000000'.replace(r, '$1'));
console.log('1.23450000'.replace(r, '$1'));
