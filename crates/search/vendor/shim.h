/* Narrow standalone adapter for PostgreSQL's text parser, not a SQL engine.
 * Rust owns valid UTF-8 input; all C allocations are per-call and bounded.
 * Failures unwind only C frames to the C entrypoint, then return an error.
 */
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <wctype.h>
#include <ctype.h>
#include <limits.h>
#include <setjmp.h>

typedef uint32_t pg_wchar;
typedef uint16_t uint16;
typedef struct HAllocation { void *data; size_t size; struct HAllocation *next; } HAllocation;
typedef struct { jmp_buf error; HAllocation *allocations; size_t bytes; unsigned ticks; uintptr_t stack; } HContext;
#ifdef _MSC_VER
__declspec(thread) static HContext *h_context;
#else
static _Thread_local HContext *h_context;
#endif
static void *h_alloc(size_t size,bool zero) {
    if(size>8*1024*1024 || h_context->bytes>8*1024*1024-size) longjmp(h_context->error,1);
    HAllocation *node=malloc(sizeof(*node));
    if(!node) longjmp(h_context->error,1);
    node->data=zero?calloc(1,size):malloc(size);
    if(!node->data) {free(node);longjmp(h_context->error,1);}
    node->size=size; node->next=h_context->allocations;h_context->allocations=node;h_context->bytes+=size;
    return node->data;
}
static void h_free(void *data) {
    HAllocation **p=&h_context->allocations;
    while(*p) { HAllocation *node=*p; if(node->data==data){*p=node->next;h_context->bytes-=node->size;free(data);free(node);return;}p=&node->next; }
}
#define palloc(n) h_alloc((n),false)
#define palloc0(n) h_alloc((n),true)
#define pfree(p) h_free(p)
#define Assert(v) do {if(!(v)) longjmp(h_context->error,1);}while(0)
#define CppConcat(a,b) a##b
#define lengthof(v) (sizeof(v)/sizeof((v)[0]))
#define PG_UTF8 6
#define GetDatabaseEncoding() PG_UTF8
#define pg_database_encoding_max_length() 4
#define CHECK_FOR_INTERRUPTS() do {if(++h_context->ticks>32000000)longjmp(h_context->error,1);}while(0)
static void check_stack_depth(void) {char stack;uintptr_t here=(uintptr_t)&stack;size_t distance=here>h_context->stack?here-h_context->stack:h_context->stack-here;if(distance>256*1024)longjmp(h_context->error,1);}
static int pg_mblen_range(const char *s,const char *end) {if(s>=end)return 0;unsigned char c=*s;int n=c<128?1:c<224?2:c<240?3:4;Assert(end-s>=n);return n;}
static uint32_t h_codepoint(const char *s,int *bytes) {unsigned char c=*s;uint32_t v;int n=c<128?1:c<224?2:c<240?3:4;v=n==1?c:c&((1u<<(7-n))-1);for(int i=1;i<n;i++)v=(v<<6)|((unsigned char)s[i]&63);*bytes=n;return v;}
static void pg_mb2wchar_with_len(const char *s,pg_wchar *out,int len) {int pos=0,n;while(pos<len){*out++=h_codepoint(s+pos,&n);pos+=n;}*out=0;}
extern int harmony_char_class(uint32_t c,const char *name);
extern int harmony_char_width(uint32_t c);
static int pg_dsplen(const char *s) {int n;return harmony_char_width(h_codepoint(s,&n));}
static int pg_strncasecmp(const char *a,const char *b,size_t n){for(size_t i=0;i<n;i++){int x=tolower((unsigned char)a[i]),y=tolower((unsigned char)b[i]);if(x!=y)return x-y;if(!x)return 0;}return 0;}
#ifndef isascii
#define isascii(c) ((unsigned)(c)<128)
#endif
