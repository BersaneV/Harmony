
typedef void (*HToken)(void *,int,const char *,size_t);
int harmony_pg_tokens(const char *input,size_t length,void *context,HToken emit) {
    if(length>65536 || memchr(input,0,length))return 1;
    HContext *state=calloc(1,sizeof(*state));char stack;
    if(!state)return 1;
    state->stack=(uintptr_t)&stack;
    h_context=state;
    int status=setjmp(state->error);
    if(!status) {
        TParser *parser=TParserInit((char *)input,(int)length);
        while(TParserGet(parser)) {
            if(parser->lenbytetoken>0 && parser->lenbytetoken<2048)
                emit(context,parser->type,parser->token,(size_t)parser->lenbytetoken);
        }
        TParserClose(parser);
    }
    while(state->allocations)h_free(state->allocations->data);
    free(state);
    h_context=NULL;
    return status;
}
